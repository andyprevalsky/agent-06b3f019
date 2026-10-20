#!/usr/bin/env tsx
/**
 * Structural dependency test for layered domain architecture.
 *
 * Automatically scans all domains in src/domains/ and verifies 10 invariants:
 *
 *   1. Import direction (per domain layer)
 *   2. Cross-domain isolation
 *   3. Provider boundary (providers never import domains)
 *   4. Utils boundary (utils never import from src/)
 *   5. Domain completeness (5 required files)
 *   6. No Prisma outside repo/types layer
 *   7. No Express outside routes layer
 *   8. No circular imports within domains
 *   9. server.ts wires from domains/, not routes/
 *  10. Raw interactive transactions cannot bypass the canonical timeout policy
 *
 * Cross-cutting concern enforcement (canonical utilities) is handled by
 * ESLint custom rules in eslint.config.mjs, not by structural tests.
 * See /enforce-canonical-utility skill.
 *
 * Usage:
 *   npx tsx src/tests/structural/layer-deps.test.ts
 */

import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  checkInteractiveTransactionPolicy,
  findRawInteractiveTransactions,
} from './interactive-transaction-policy';

const SRC_DIR = path.resolve(__dirname, '../..');
const DOMAINS_DIR = path.join(SRC_DIR, 'domains');
const PROVIDERS_DIR = path.join(SRC_DIR, 'providers');
const UTILS_DIR = path.join(SRC_DIR, 'utils');
const SERVER_FILE = path.join(SRC_DIR, 'server.ts');

type Layer = 'types' | 'config' | 'repo' | 'service' | 'routes';

const LAYER_ORDER: Layer[] = ['types', 'config', 'repo', 'service', 'routes'];
const REQUIRED_FILES: Layer[] = ['types', 'config', 'repo', 'service', 'routes'];

function getLayer(filename: string): Layer | null {
  const base = path.basename(filename, '.ts');
  if (LAYER_ORDER.includes(base as Layer)) return base as Layer;
  // Recognize split files: repoMutations.ts → repo, routesAdmin.ts → routes, etc.
  if (base.startsWith('routes')) return 'routes';
  if (base.startsWith('repo')) return 'repo';
  if (base === 'types' || base === 'config') return base;
  // Any remaining service-like files (agentControlService, uploadService.browser, etc.)
  if (base.includes('service') || base.includes('Service')) return 'service';
  return null;
}

// ── Import parsing ──

interface ImportInfo {
  raw: string;
  kind: 'same-domain' | 'other-domain' | 'provider' | 'util' | 'external';
  targetLayer?: Layer;
}

function parseImportPaths(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const importRegex = /(?:import|from)\s+['"]([^'"]+)['"]/g;
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    results.push(match[1]);
  }
  return results;
}

function parseImports(filePath: string): ImportInfo[] {
  return parseImportPaths(filePath).map((raw) => classifyImport(raw, filePath));
}

function classifyImport(raw: string, filePath: string): ImportInfo {
  if (!raw.startsWith('.')) {
    return { raw, kind: 'external' };
  }

  const resolved = path.resolve(path.dirname(filePath), raw);
  const domainsAbs = path.resolve(DOMAINS_DIR);

  const sep = path.sep;
  if (resolved.includes(`${sep}providers${sep}`) || resolved.endsWith(`${sep}providers`)) {
    return { raw, kind: 'provider' };
  }

  // Legacy services/ directory — treated as providers (shared infrastructure)
  if (resolved.includes(`${sep}services${sep}`) || resolved.endsWith(`${sep}services`)) {
    return { raw, kind: 'provider' };
  }

  if (resolved.includes(`${sep}utils${sep}`) || resolved.endsWith(`${sep}utils`)) {
    return { raw, kind: 'util' };
  }

  const currentDomain = path.relative(domainsAbs, path.dirname(filePath)).split(path.sep)[0];
  const targetDir = path.relative(domainsAbs, resolved).split(path.sep)[0];

  if (targetDir !== currentDomain) {
    return { raw, kind: 'other-domain' };
  }

  const targetBase = path.basename(raw, '.ts');
  const targetLayer = getLayer(targetBase + '.ts') ?? undefined;
  return { raw, kind: 'same-domain', targetLayer };
}

// ── Violation tracking ──

interface Violation {
  category: string;
  file: string;
  message: string;
  fix: string;
}

let totalTests = 0;
let passed = 0;
let failed = 0;
const allViolations: Violation[] = [];

function runCheck(label: string, violations: Violation[]): void {
  totalTests++;
  if (violations.length === 0) {
    console.log(`  PASS ${label}`);
    passed++;
  } else {
    console.log(`  FAIL ${label}`);
    failed++;
    for (const v of violations) {
      console.log(`    ${v.category} in ${v.file}:\n      ${v.message}\n      → Fix: ${v.fix}`);
    }
    allViolations.push(...violations);
  }
}

// ── Invariant 1+2: Layer direction + cross-domain isolation ──

const ALLOWED_SAME_DOMAIN: Record<Layer, Layer[]> = {
  types: [],
  config: ['types'],
  repo: ['types', 'config', 'repo'], // peer repo imports allowed (split repo files)
  service: ['repo', 'types', 'config', 'service'], // peer service imports allowed (split service files)
  routes: ['service', 'types', 'config', 'routes'], // peer routes + config imports allowed (split route files)
};

const ALLOWED_EXTERNAL: Record<Layer, { providers: boolean; utils: boolean }> = {
  types: { providers: true, utils: false },
  config: { providers: false, utils: false },
  repo: { providers: true, utils: false },
  service: { providers: true, utils: true },
  routes: { providers: true, utils: true },
};

function checkLayerDeps(filePath: string, layer: Layer, domain: string): Violation[] {
  const violations: Violation[] = [];
  const imports = parseImports(filePath);

  for (const imp of imports) {
    if (imp.kind === 'external') continue;

    if (imp.kind === 'other-domain') {
      violations.push({
        category: 'CROSS-DOMAIN VIOLATION',
        file: `domains/${domain}/${path.basename(filePath)}`,
        message: `Imports '${imp.raw}' from another domain`,
        fix: `Extract shared logic into providers/ so both domains can use it.`,
      });
      continue;
    }

    if (imp.kind === 'same-domain') {
      if (imp.targetLayer !== undefined && !ALLOWED_SAME_DOMAIN[layer].includes(imp.targetLayer)) {
        violations.push({
          category: 'LAYER VIOLATION',
          file: `domains/${domain}/${path.basename(filePath)}`,
          message: `Imports '${imp.raw}' but ${layer} may only import from: ${ALLOWED_SAME_DOMAIN[layer].join(', ') || 'none'}`,
          fix: `Move the needed logic to an allowed layer or extract to a provider.`,
        });
      }
      continue;
    }

    if (imp.kind === 'provider' && !ALLOWED_EXTERNAL[layer].providers) {
      violations.push({
        category: 'LAYER VIOLATION',
        file: `domains/${domain}/${path.basename(filePath)}`,
        message: `${layer} may not import from providers/`,
        fix: `Move the provider dependency to a higher layer (service or routes).`,
      });
      continue;
    }

    if (imp.kind === 'util' && !ALLOWED_EXTERNAL[layer].utils) {
      violations.push({
        category: 'LAYER VIOLATION',
        file: `domains/${domain}/${path.basename(filePath)}`,
        message: `${layer} may not import from utils/`,
        fix: `Move the util usage to routes.ts or service.ts.`,
      });
    }
  }

  return violations;
}

// ── Invariant 3: Provider boundary ──

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.spec.ts')
    ) {
      results.push(full);
    }
  }
  return results;
}

function checkProviderBoundary(): Violation[] {
  const violations: Violation[] = [];
  for (const filePath of collectTsFiles(PROVIDERS_DIR)) {
    for (const raw of parseImportPaths(filePath)) {
      if (!raw.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(filePath), raw);
      if (resolved.startsWith(DOMAINS_DIR + path.sep)) {
        violations.push({
          category: 'PROVIDER BOUNDARY VIOLATION',
          file: path.relative(SRC_DIR, filePath),
          message: `Imports '${raw}' from domains/ but providers must be domain-agnostic`,
          fix: `Move the shared type to the provider itself or to a shared types export within providers/.`,
        });
      }
    }
  }
  return violations;
}

// ── Invariant 4: Utils boundary ──

function checkUtilsBoundary(): Violation[] {
  const violations: Violation[] = [];
  for (const filePath of collectTsFiles(UTILS_DIR)) {
    for (const raw of parseImportPaths(filePath)) {
      if (!raw.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(filePath), raw);
      // utils/ must not import from anything in src/ (providers, domains, services)
      if (
        resolved.startsWith(path.join(SRC_DIR, 'providers') + path.sep) ||
        resolved.startsWith(path.join(SRC_DIR, 'domains') + path.sep) ||
        resolved.startsWith(path.join(SRC_DIR, 'services') + path.sep)
      ) {
        violations.push({
          category: 'UTILS BOUNDARY VIOLATION',
          file: path.relative(SRC_DIR, filePath),
          message: `Imports '${raw}' but utils/ must have zero src/ dependencies`,
          fix: `utils/ must have zero src/ dependencies. Move this to providers/ or inline it.`,
        });
      }
    }
  }
  return violations;
}

// ── Invariant 5: Domain completeness ──

function checkDomainCompleteness(domain: string): Violation[] {
  const domainDir = path.join(DOMAINS_DIR, domain);
  const files = fs.readdirSync(domainDir);
  const missing = REQUIRED_FILES.filter((f) => !files.includes(`${f}.ts`));
  if (missing.length === 0) return [];
  return [
    {
      category: 'COMPLETENESS VIOLATION',
      file: `domains/${domain}`,
      message: `Missing: ${missing.map((f) => `${f}.ts`).join(', ')}`,
      fix: `Create the file. If the domain has no ${missing[0]}, use: export {};`,
    },
  ];
}

// ── Invariant 6: Prisma boundary ──

function getEffectiveLayer(fileBase: string): 'routes' | 'repo' | 'types' | 'config' | 'service' {
  if (fileBase.startsWith('routes')) return 'routes';
  // Repo layer: `repo.ts` and split files named `repo*` or `*Repo` (e.g. grepRepo).
  if (fileBase.startsWith('repo') || fileBase.endsWith('Repo')) return 'repo';
  if (fileBase === 'types') return 'types';
  if (fileBase === 'config') return 'config';
  return 'service';
}

function checkPrismaBoundary(filePath: string, fileBase: string, domain: string): Violation[] {
  const effective = getEffectiveLayer(fileBase);
  // repo and types layers are allowed to import Prisma
  if (effective === 'repo' || effective === 'types') return [];

  const violations: Violation[] = [];
  const content = fs.readFileSync(filePath, 'utf-8');

  if (/from\s+['"]@prisma\/client['"]/.test(content)) {
    violations.push({
      category: 'PRISMA BOUNDARY VIOLATION',
      file: `domains/${domain}/${path.basename(filePath)}`,
      message: `Imports @prisma/client but only repo.ts and types.ts may use Prisma`,
      fix: `Move the query to repo.ts and call it from ${fileBase}.ts, or re-export types from types.ts.`,
    });
  }

  if (/from\s+['"].*providers\/database['"]/.test(content)) {
    violations.push({
      category: 'PRISMA BOUNDARY VIOLATION',
      file: `domains/${domain}/${path.basename(filePath)}`,
      message: `Imports prisma client directly but only repo.ts may access the database`,
      fix: `Move the database access to repo.ts and call it from ${fileBase}.ts.`,
    });
  }

  return violations;
}

// ── Invariant 7: Express boundary ──

function checkExpressBoundary(filePath: string, fileBase: string, domain: string): Violation[] {
  if (getEffectiveLayer(fileBase) === 'routes') return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  if (/from\s+['"]express['"]/.test(content)) {
    return [
      {
        category: 'EXPRESS LEAK',
        file: `domains/${domain}/${path.basename(filePath)}`,
        message: `Imports 'express' but ${fileBase} must be framework-agnostic`,
        fix: `Accept typed args instead of req/res. Move HTTP handling to routes.ts.`,
      },
    ];
  }
  return [];
}

// ── Invariant 8: Circular imports ──

function checkCircularImports(domain: string): Violation[] {
  const domainDir = path.join(DOMAINS_DIR, domain);
  const files = fs.readdirSync(domainDir).filter((f) => f.endsWith('.ts'));

  // Build adjacency list: file base name → imported file base names (within domain)
  const graph: Record<string, string[]> = {};

  for (const file of files) {
    const base = path.basename(file, '.ts');
    const filePath = path.join(domainDir, file);
    graph[base] = [];

    for (const imp of parseImports(filePath)) {
      if (imp.kind === 'same-domain') {
        const targetBase = path.basename(imp.raw, '.ts').replace(/^\.\//, '');
        if (targetBase !== base) {
          graph[base].push(targetBase);
        }
      }
    }
  }

  // DFS cycle detection
  const violations: Violation[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string, pathSoFar: string[]): void {
    if (inStack.has(node)) {
      const cycleStart = pathSoFar.indexOf(node);
      const cycle = [...pathSoFar.slice(cycleStart), node];
      violations.push({
        category: 'CIRCULAR IMPORT',
        file: `domains/${domain}`,
        message: cycle.map((c) => `${c}.ts`).join(' → '),
        fix: `Break the cycle by moving shared logic to a lower layer or extracting to a provider.`,
      });
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);

    for (const neighbor of graph[node] || []) {
      dfs(neighbor, [...pathSoFar, node]);
    }

    inStack.delete(node);
  }

  for (const node of Object.keys(graph)) {
    visited.clear();
    inStack.clear();
    dfs(node, []);
  }

  // Deduplicate cycles: normalize by sorting the cycle's node set
  const seen = new Set<string>();
  return violations.filter((v) => {
    // Extract nodes from "a.ts → b.ts → a.ts", drop the repeated last node
    const nodes = v.message.split(' → ').slice(0, -1);
    const key = [...nodes].sort().join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Invariant 9: server.ts wiring ──

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkServerWiring(domains: string[]): Violation[] {
  if (!fs.existsSync(SERVER_FILE)) return [];

  const content = fs.readFileSync(SERVER_FILE, 'utf-8');
  const violations: Violation[] = [];

  for (const domain of domains) {
    // Convert kebab-case domain name to camelCase for route file matching
    const camelCase = domain.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const escapedCamelCase = escapeRegex(camelCase);
    const escapedDomain = escapeRegex(domain);

    // Check if server.ts imports from ./routes/<name> instead of ./domains/<name>/routes
    const oldRoutePattern = new RegExp(
      `from\\s+['"]\\./routes/${escapedCamelCase}(?:\\.ts)?['"]|from\\s+['"]\\./routes/${escapedDomain}(?:\\.ts)?['"]`
    );

    if (oldRoutePattern.test(content)) {
      violations.push({
        category: 'WIRING VIOLATION',
        file: 'server.ts',
        message: `Imports from old routes/ path but domain exists at ./domains/${domain}/routes`,
        fix: `Update the import path in server.ts to: import ... from './domains/${domain}/routes'`,
      });
    }
  }

  return violations;
}

// ── Domain discovery ──

function discoverDomains(): string[] {
  if (!fs.existsSync(DOMAINS_DIR)) return [];
  return fs
    .readdirSync(DOMAINS_DIR)
    .filter((d) => fs.statSync(path.join(DOMAINS_DIR, d)).isDirectory())
    .sort();
}

// ── Main ──

const domains = discoverDomains();

if (domains.length === 0) {
  console.log('No domains found in src/domains/ — nothing to check.');
  process.exit(0);
}

console.log(`Scanning ${domains.length} domains...\n`);

// ── Per-domain checks ──

for (const domain of domains) {
  console.log(`domains/${domain}`);
  const domainDir = path.join(DOMAINS_DIR, domain);
  const files = fs.readdirSync(domainDir).filter((f) => f.endsWith('.ts'));

  // Invariant 5: Domain completeness
  runCheck('completeness', checkDomainCompleteness(domain));

  // Invariant 8: Circular imports
  runCheck('no circular imports', checkCircularImports(domain));

  // Per-file checks
  for (const file of files) {
    const filePath = path.join(domainDir, file);
    const layer = getLayer(file);
    const fileBase = path.basename(file, '.ts');

    // Invariants 1+2: Layer deps (only for core layer files)
    if (layer !== null) {
      runCheck(`${file} (layer deps)`, checkLayerDeps(filePath, layer, domain));
    }

    // Invariant 6: Prisma boundary (all .ts files)
    runCheck(`${file} (prisma boundary)`, checkPrismaBoundary(filePath, fileBase, domain));

    // Invariant 7: Express boundary (all .ts files)
    runCheck(`${file} (express boundary)`, checkExpressBoundary(filePath, fileBase, domain));
  }
}

// ── Global checks ──

console.log('\n── Global boundary checks ──');

// Invariant 3: Provider boundary
runCheck('providers/ never import from domains/', checkProviderBoundary());

// Invariant 4: Utils boundary
runCheck('utils/ has zero src/ dependencies', checkUtilsBoundary());

// Invariant 9: server.ts wiring
runCheck('server.ts wires from domains/, not routes/', checkServerWiring(domains));

// PR1480 preserves the original implementation for causal comparisons. Its
// historical transaction exception must never cover an edited comparison.
const hubComparison = fs.readFileSync(path.join(PROVIDERS_DIR, 'benchmarkHubStore.base.ts'));
if (
  createHash('sha256').update(hubComparison).digest('hex') !==
  'a4a6089d5a26d8b2379ca96b4d51b387507ad333d233e27d429335313495efe5'
) {
  throw new Error('The preserved PR1480 Benchmark Hub comparison changed');
}

// Invariant 10: canonical interactive-transaction timeout/retry policy
if (
  findRawInteractiveTransactions(
    'import { prisma as db } from "./database"; db.$transaction<User>(async (tx) => tx.user.findMany())'
  ).length !== 1 ||
  findRawInteractiveTransactions(
    'const { $transaction } = db; $transaction(async (tx) => tx.user.findMany())'
  ).length !== 1 ||
  findRawInteractiveTransactions('prisma.$transaction([first, second])').length !== 0 ||
  findRawInteractiveTransactions('runTransactionWithRetry(async (tx) => tx.user.findMany())')
    .length !== 0
) {
  throw new Error('Interactive transaction policy detector failed its callback/array self-check');
}
runCheck(
  'interactive transactions use the canonical wrapper or an exact documented exception',
  checkInteractiveTransactionPolicy(SRC_DIR)
);

// ── Summary ──

console.log(`\n============================================================`);
console.log(`Results: ${passed} passed, ${failed} failed, ${totalTests} total`);

if (failed > 0) {
  console.log(`\nAll violations:`);
  for (const v of allViolations) {
    console.log(`\n${v.category} in ${v.file}:\n  ${v.message}\n  → Fix: ${v.fix}`);
  }
  process.exit(1);
} else {
  console.log('\nAll structural checks passed.');
  process.exit(0);
}
