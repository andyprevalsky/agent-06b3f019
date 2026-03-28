#!/usr/bin/env tsx
/**
 * Structural dependency test for layered domain architecture.
 *
 * Automatically scans all domains in src/domains/ and verifies that
 * every import follows the forward-only direction rules:
 *
 *   types.ts   → external packages + providers (Prisma types only)
 *   config.ts  → own types
 *   repo.ts    → own types, own config, providers/database
 *   service.ts → own repo, own types, own config, providers/*
 *   routes.ts  → own service, own types, providers/*, utils/asyncHandler
 *
 * Usage:
 *   npx tsx src/tests/structural/layer-deps.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const DOMAINS_DIR = path.resolve(__dirname, '../../domains');

type Layer = 'types' | 'config' | 'repo' | 'service' | 'routes';

const LAYER_ORDER: Layer[] = ['types', 'config', 'repo', 'service', 'routes'];

function getLayer(filename: string): Layer | null {
  const base = path.basename(filename, '.ts');
  if (LAYER_ORDER.includes(base as Layer)) return base as Layer;
  return null;
}

interface ImportInfo {
  raw: string;
  kind: 'same-domain' | 'other-domain' | 'provider' | 'util' | 'external';
  targetLayer?: Layer;
}

function parseImports(filePath: string): ImportInfo[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const importRegex = /(?:import|from)\s+['"]([^'"]+)['"]/g;
  const results: ImportInfo[] = [];
  let match: RegExpExecArray | null;

  while ((match = importRegex.exec(content)) !== null) {
    const raw = match[1];
    results.push(classifyImport(raw, filePath));
  }

  return results;
}

function classifyImport(raw: string, filePath: string): ImportInfo {
  if (!raw.startsWith('.')) {
    return { raw, kind: 'external' };
  }

  const resolved = path.resolve(path.dirname(filePath), raw);
  const domainsAbs = path.resolve(DOMAINS_DIR);

  if (resolved.includes('/providers/') || resolved.includes('/providers')) {
    return { raw, kind: 'provider' };
  }

  if (resolved.includes('/utils/') || resolved.includes('/utils')) {
    return { raw, kind: 'util' };
  }

  const currentDomain = path.relative(domainsAbs, path.dirname(filePath)).split(path.sep)[0];
  const targetDir = path.relative(domainsAbs, resolved).split(path.sep)[0];

  if (targetDir !== currentDomain) {
    return { raw, kind: 'other-domain' };
  }

  const targetBase = path.basename(raw, '.ts');
  const targetLayer = LAYER_ORDER.includes(targetBase as Layer) ? (targetBase as Layer) : undefined;
  return { raw, kind: 'same-domain', targetLayer };
}

interface Violation {
  file: string;
  layer: Layer;
  importPath: string;
  reason: string;
  fix: string;
}

const ALLOWED_SAME_DOMAIN: Record<Layer, Layer[]> = {
  types: [],
  config: ['types'],
  repo: ['types', 'config'],
  service: ['repo', 'types', 'config'],
  routes: ['service', 'types'],
};

const ALLOWED_EXTERNAL: Record<Layer, { providers: boolean; utils: boolean }> = {
  types: { providers: true, utils: false },
  config: { providers: false, utils: false },
  repo: { providers: true, utils: false },
  service: { providers: true, utils: true },
  routes: { providers: true, utils: true },
};

function checkFile(filePath: string, layer: Layer): Violation[] {
  const violations: Violation[] = [];
  const imports = parseImports(filePath);

  for (const imp of imports) {
    if (imp.kind === 'external') continue;

    if (imp.kind === 'other-domain') {
      violations.push({
        file: filePath,
        layer,
        importPath: imp.raw,
        reason: `Cross-domain import detected`,
        fix: `Extract shared logic into providers/ so both domains can use it.`,
      });
      continue;
    }

    if (imp.kind === 'same-domain') {
      if (imp.targetLayer !== undefined && !ALLOWED_SAME_DOMAIN[layer].includes(imp.targetLayer)) {
        violations.push({
          file: filePath,
          layer,
          importPath: imp.raw,
          reason: `${layer} may not import from ${imp.targetLayer}. Allowed: ${ALLOWED_SAME_DOMAIN[layer].join(', ') || 'none'}`,
          fix: `Move the needed logic to an allowed layer or extract to a provider.`,
        });
      }
      continue;
    }

    if (imp.kind === 'provider' && !ALLOWED_EXTERNAL[layer].providers) {
      violations.push({
        file: filePath,
        layer,
        importPath: imp.raw,
        reason: `${layer} may not import from providers/`,
        fix: `Move the provider dependency to a higher layer (service or routes).`,
      });
      continue;
    }

    if (imp.kind === 'util' && !ALLOWED_EXTERNAL[layer].utils) {
      violations.push({
        file: filePath,
        layer,
        importPath: imp.raw,
        reason: `${layer} may not import from utils/`,
        fix: `Move the util usage to routes.ts or service.ts.`,
      });
    }
  }

  return violations;
}

function discoverDomains(): string[] {
  if (!fs.existsSync(DOMAINS_DIR)) return [];
  return fs.readdirSync(DOMAINS_DIR).filter((d) => {
    return fs.statSync(path.join(DOMAINS_DIR, d)).isDirectory();
  });
}

// ── Runner ──

let totalTests = 0;
let passed = 0;
let failed = 0;
const failures: string[] = [];

const domains = discoverDomains();

if (domains.length === 0) {
  console.log('No domains found in src/domains/ — nothing to check.');
  process.exit(0);
}

for (const domain of domains) {
  console.log(`\ndomains/${domain}`);
  const domainDir = path.join(DOMAINS_DIR, domain);
  const files = fs.readdirSync(domainDir).filter((f) => f.endsWith('.ts'));

  for (const file of files) {
    const layer = getLayer(file);
    if (layer === null) continue;

    totalTests++;
    const filePath = path.join(domainDir, file);
    const violations = checkFile(filePath, layer);

    if (violations.length === 0) {
      console.log(`  PASS ${file}`);
      passed++;
    } else {
      console.log(`  FAIL ${file}`);
      failed++;
      for (const v of violations) {
        const msg =
          `LAYER VIOLATION in domains/${domain}/${file}:\n` +
          `  Imports '${v.importPath}' but ${v.reason}\n` +
          `  → Fix: ${v.fix}`;
        console.log(`    ${msg}`);
        failures.push(msg);
      }
    }
  }
}

console.log(`\n============================================================`);
console.log(`Results: ${passed} passed, ${failed} failed, ${totalTests} total`);

if (failed > 0) {
  console.log(`\n${failures.join('\n\n')}`);
  process.exit(1);
} else {
  console.log('\nAll layer dependency checks passed.');
  process.exit(0);
}
