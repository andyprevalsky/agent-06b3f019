#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Structural dependency test for the research repo's layered domain architecture.
 *
 * Scans all domains in research/domains/ and verifies 9 invariants:
 *
 *   1. Import direction (per-layer rules: types → config → repo → service → runtime)
 *   2. Cross-domain isolation  (no domain imports another domain's files)
 *   3. Provider boundary       (providers/ never import from domains/)
 *   4. Utils boundary          (utils/ never imports from any research/ source tree)
 *   5. Domain completeness     (required layer files exist — TS vs Python sets)
 *   6. Data access boundary    (Supabase client usable only from repo or runtime entry)
 *   7. Framework leak          (Deno edge-function primitives only in runtime/handler)
 *   8. Circular imports        (no import cycles inside a domain)
 *   9. Wiring correctness      (supabase/functions/<d>/index.ts imports from domains/<d>/)
 *
 * Python domains (gepa) participate only in invariants 3, 4, 5 (via Python-aware
 * required-file set).  Import-direction / framework-leak / data-access
 * invariants for Python are TBD; deferred to a follow-up.  Gepa's
 * `research.gepa.*` legacy imports are NOT cross-domain — they reach the
 * parallel legacy module tree at `research/gepa/`, which is intentional.
 *
 * Usage:
 *   npx tsx research/tests/structural/layer-deps.ts
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, dirname, relative, resolve, sep } from 'path';
import process from 'node:process';

const RESEARCH = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const DOMAINS_DIR = resolve(RESEARCH, 'domains');
const PROVIDERS_DIR = resolve(RESEARCH, 'providers');
const UTILS_DIR = resolve(RESEARCH, 'utils');
const FUNCTIONS_DIR = resolve(RESEARCH, 'supabase/functions');

// ---------------------------------------------------------------------------
// Layer classification
// ---------------------------------------------------------------------------

type Layer = 'types' | 'config' | 'repo' | 'service' | 'utils' | 'runtime';

/**
 * Return the canonical layer for a file path inside a domain.
 * Handles:
 *   - Core files by basename: types.ts, config.ts, repo.ts, service.ts, utils.ts
 *   - Split files: repo-*.ts, service-*.ts, service/*.ts (all service layer),
 *     except service/handler.ts which is the completions runtime entry.
 *   - Runtime entries: runtime.ts, handler.ts
 */
function classifyFile(filePath: string, domainDir: string): Layer | null {
  const rel = relative(domainDir, filePath);
  const base = basename(rel, '.ts');
  const parts = rel.split(sep);

  // Split-out files inside service/ subdirectory ARE service layer,
  // EXCEPT for service/handler.ts (completions' runtime entry).
  if (parts.length > 1 && parts[0] === 'service') {
    if (base === 'handler' || base === 'runtime') return 'runtime';
    return 'service';
  }

  if (base === 'handler' || base === 'runtime') return 'runtime';
  if (base === 'types') return 'types';
  if (base === 'config') return 'config';
  if (base === 'utils') return 'utils';
  if (base === 'repo' || base.startsWith('repo-')) return 'repo';
  if (base === 'service' || base.startsWith('service-')) return 'service';
  return null;
}

// ---------------------------------------------------------------------------
// Allowed same-domain imports per layer
// ---------------------------------------------------------------------------

const ALLOWED_SAME_DOMAIN: Record<Layer, Layer[]> = {
  // types has no same-domain deps — purely external + own split types
  types: ['types'],
  // config may import types + other config split files
  config: ['types', 'config'],
  // repo may import types, config, utils (pure helpers), peer repo split files
  repo: ['types', 'config', 'utils', 'repo'],
  // service may import anything below it + peer services
  service: ['types', 'config', 'utils', 'repo', 'service'],
  // utils is the lowest pure helper layer inside a domain — only types + config
  utils: ['types', 'config', 'utils'],
  // runtime is the top layer — may import everything below
  runtime: ['types', 'config', 'utils', 'repo', 'service', 'runtime'],
};

const ALLOWS_PROVIDERS: Record<Layer, boolean> = {
  types: true,
  config: false,
  repo: true,
  service: true,
  utils: false,
  runtime: true,
};

const ALLOWS_TOP_UTILS: Record<Layer, boolean> = {
  types: false,
  config: false,
  repo: false,
  service: true,
  utils: false,
  runtime: true,
};

// ---------------------------------------------------------------------------
// Import parsing
// ---------------------------------------------------------------------------

function parseImportPaths(filePath: string): string[] {
  const content = readFileSync(filePath, 'utf-8');
  const results: string[] = [];
  // Covers: `import ... from '...'`, bare `import '...'`, and re-exports:
  // `export * from '...'` / `export { foo } from '...'` (with optional `type`).
  // Re-exports create the same dependency edges as imports and must be tracked
  // so layer-direction, cross-domain, and circular-import checks see them.
  const regex =
    /(?:import\s+(?:type\s+)?[^'"`;]*from|import|export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from)\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    results.push(match[1]);
  }
  return results;
}

interface ImportInfo {
  raw: string;
  kind: 'same-domain' | 'other-domain' | 'provider' | 'top-utils' | 'external';
  targetLayer?: Layer;
}

function classifyImport(raw: string, filePath: string, domainDir: string): ImportInfo {
  // Non-relative → external (npm:, https://, @scope/pkg, etc.)
  if (!raw.startsWith('.')) {
    return { raw, kind: 'external' };
  }

  const resolved = resolve(dirname(filePath), raw);

  // Top-level providers/ or utils/
  if (resolved.startsWith(PROVIDERS_DIR + sep) || resolved === PROVIDERS_DIR) {
    return { raw, kind: 'provider' };
  }
  if (resolved.startsWith(UTILS_DIR + sep) || resolved === UTILS_DIR) {
    return { raw, kind: 'top-utils' };
  }

  // Inside domains/?
  if (resolved.startsWith(DOMAINS_DIR + sep)) {
    const domainRel = relative(DOMAINS_DIR, resolved);
    const targetDomain = domainRel.split(sep)[0];
    const currentDomain = relative(DOMAINS_DIR, domainDir).split(sep)[0];
    if (targetDomain !== currentDomain) {
      return { raw, kind: 'other-domain' };
    }
    // Resolve the actual target file (handle omitted .ts extensions / index files)
    let targetFile = resolved;
    if (!targetFile.endsWith('.ts')) {
      if (existsSync(targetFile + '.ts')) targetFile += '.ts';
      else if (existsSync(resolve(targetFile, 'index.ts'))) {
        targetFile = resolve(targetFile, 'index.ts');
      }
    }
    const layer = classifyFile(targetFile, domainDir) ?? undefined;
    return { raw, kind: 'same-domain', targetLayer: layer };
  }

  // Relative but escapes the domain — treat as external (e.g. research/shared)
  return { raw, kind: 'external' };
}

// ---------------------------------------------------------------------------
// Violation bookkeeping
// ---------------------------------------------------------------------------

interface Violation {
  category: string;
  file: string;
  message: string;
  fix: string;
}

let totalChecks = 0;
let passed = 0;
let failed = 0;
const allViolations: Violation[] = [];

function runCheck(label: string, violations: Violation[]): void {
  totalChecks++;
  if (violations.length === 0) {
    console.log(`  PASS ${label}`);
    passed++;
    return;
  }
  console.log(`  FAIL ${label}`);
  failed++;
  for (const v of violations) {
    console.log(`    ${v.category} in ${v.file}:`);
    console.log(`      ${v.message}`);
    console.log(`      → Fix: ${v.fix}`);
  }
  allViolations.push(...violations);
}

// ---------------------------------------------------------------------------
// Invariant 1 + 2: Layer direction & cross-domain isolation
// ---------------------------------------------------------------------------

function checkLayerDeps(
  filePath: string,
  layer: Layer,
  domain: string,
  domainDir: string,
): Violation[] {
  const violations: Violation[] = [];
  const fileLabel = `domains/${domain}/${relative(domainDir, filePath)}`;

  for (const raw of parseImportPaths(filePath)) {
    const imp = classifyImport(raw, filePath, domainDir);
    if (imp.kind === 'external') continue;

    if (imp.kind === 'other-domain') {
      violations.push({
        category: 'CROSS-DOMAIN VIOLATION',
        file: fileLabel,
        message: `Imports '${imp.raw}' from another domain`,
        fix: `Extract shared logic into providers/ so both domains can use it.`,
      });
      continue;
    }

    if (imp.kind === 'same-domain') {
      // Split-file peer imports (e.g. service-a imports from ./service-b) are
      // allowed provided both resolve to the same logical layer.
      if (imp.targetLayer && !ALLOWED_SAME_DOMAIN[layer].includes(imp.targetLayer)) {
        const allowed = ALLOWED_SAME_DOMAIN[layer].join(', ') || 'none';
        violations.push({
          category: 'LAYER VIOLATION',
          file: fileLabel,
          message:
            `Imports '${imp.raw}' (${imp.targetLayer}) but ${layer} may only import from: ${allowed}`,
          fix: `Move the needed logic to an allowed layer or extract it to a provider.`,
        });
      }
      continue;
    }

    if (imp.kind === 'provider' && !ALLOWS_PROVIDERS[layer]) {
      violations.push({
        category: 'LAYER VIOLATION',
        file: fileLabel,
        message: `${layer} may not import from providers/`,
        fix: `Move the provider dependency to a higher layer (service or runtime).`,
      });
      continue;
    }

    if (imp.kind === 'top-utils' && !ALLOWS_TOP_UTILS[layer]) {
      violations.push({
        category: 'LAYER VIOLATION',
        file: fileLabel,
        message: `${layer} may not import from utils/`,
        fix: `Move the util usage to service or runtime.`,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Invariant 3: Provider boundary — providers/ may not import from domains/
// ---------------------------------------------------------------------------

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.blackbox.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function checkProviderBoundary(): Violation[] {
  const violations: Violation[] = [];
  const files = collectTsFiles(PROVIDERS_DIR);
  for (const filePath of files) {
    for (const raw of parseImportPaths(filePath)) {
      if (!raw.startsWith('.')) continue;
      const resolved = resolve(dirname(filePath), raw);
      if (resolved.startsWith(DOMAINS_DIR + sep)) {
        violations.push({
          category: 'PROVIDER BOUNDARY VIOLATION',
          file: `providers/${relative(PROVIDERS_DIR, filePath)}`,
          message: `Imports '${raw}' from domains/ but providers must be domain-agnostic`,
          fix:
            `Move the shared type/util into providers/ itself, or import the needed symbol from an external package.`,
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Invariant 4: Utils boundary — utils/ must not import any research/ source
// ---------------------------------------------------------------------------

function checkUtilsBoundary(): Violation[] {
  const violations: Violation[] = [];
  const files = collectTsFiles(UTILS_DIR);
  for (const filePath of files) {
    for (const raw of parseImportPaths(filePath)) {
      if (!raw.startsWith('.')) continue;
      const resolved = resolve(dirname(filePath), raw);
      if (resolved.startsWith(RESEARCH + sep) && !resolved.startsWith(UTILS_DIR + sep)) {
        violations.push({
          category: 'UTILS BOUNDARY VIOLATION',
          file: `utils/${relative(UTILS_DIR, filePath)}`,
          message: `Imports '${raw}' but utils/ must have zero research/ dependencies`,
          fix:
            `Move this helper to providers/, inline it in its caller, or make it truly standalone.`,
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Invariant 5: Domain completeness
// ---------------------------------------------------------------------------

// Python-flavored domains use .py files + a runtime/ subdir entry.
const PY_DOMAINS = new Set(['gepa']);

// TS domain required files: types, config, repo, service, + one runtime entry
// (runtime.ts OR handler.ts OR service/handler.ts for completions).
const TS_REQUIRED_LAYER_FILES = ['types.ts', 'config.ts', 'repo.ts'];

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => e.name);
}

function hasServiceLayer(domainDir: string, files: string[]): boolean {
  // Either a top-level service.ts / service-*.ts file, OR a service/ subdir
  // with at least one file that classifyFile() treats as 'service' (so a
  // runtime adapter under service/handler.ts or service/runtime.ts does not
  // satisfy completeness).
  if (files.includes('service.ts')) return true;
  if (files.some((f) => f.startsWith('service-') && f.endsWith('.ts'))) return true;
  const subdir = resolve(domainDir, 'service');
  if (existsSync(subdir) && statSync(subdir).isDirectory()) {
    const serviceFiles = collectTsFiles(subdir).filter(
      (f) => classifyFile(f, domainDir) === 'service',
    );
    if (serviceFiles.length > 0) return true;
  }
  return false;
}

function hasRuntimeEntry(domainDir: string, files: string[]): boolean {
  if (files.includes('runtime.ts') || files.includes('handler.ts')) return true;
  // Completions-style: service/handler.ts or service/runtime.ts
  const serviceHandler = resolve(domainDir, 'service/handler.ts');
  const serviceRuntime = resolve(domainDir, 'service/runtime.ts');
  return existsSync(serviceHandler) || existsSync(serviceRuntime);
}

function checkDomainCompletenessTs(domain: string, domainDir: string): Violation[] {
  const files = listFiles(domainDir);
  const missing: string[] = [];

  for (const required of TS_REQUIRED_LAYER_FILES) {
    // Allow a split-layer file (e.g. repo-foo.ts) to satisfy requirement if
    // the base file itself is missing.
    const base = required.replace('.ts', '');
    const hasBase = files.includes(required);
    const hasSplit = files.some((f) => f.startsWith(`${base}-`) && f.endsWith('.ts'));
    if (!hasBase && !hasSplit) missing.push(required);
  }

  if (!hasServiceLayer(domainDir, files)) {
    missing.push('service.ts (or service-*.ts, or service/)');
  }
  if (!hasRuntimeEntry(domainDir, files)) {
    missing.push('runtime.ts (or handler.ts, or service/handler.ts)');
  }

  if (missing.length === 0) return [];
  return [{
    category: 'COMPLETENESS VIOLATION',
    file: `domains/${domain}`,
    message: `Missing required layer file(s): ${missing.join(', ')}`,
    fix: `Create the file(s). For layers with no logic yet, use: export {};`,
  }];
}

function checkDomainCompletenessPython(domain: string, domainDir: string): Violation[] {
  const required = ['types.py', 'config.py', 'repo.py', 'service.py'];
  const files = listFiles(domainDir);
  const missing = required.filter((r) => !files.includes(r));

  const runtimeDir = resolve(domainDir, 'runtime');
  let hasRuntimeEntryPy = false;
  if (existsSync(runtimeDir) && statSync(runtimeDir).isDirectory()) {
    hasRuntimeEntryPy = readdirSync(runtimeDir).some((f) =>
      f.endsWith('.py') && f !== '__init__.py'
    );
  }
  if (!hasRuntimeEntryPy) missing.push('runtime/ (directory with at least one .py entry)');

  if (missing.length === 0) return [];
  return [{
    category: 'COMPLETENESS VIOLATION',
    file: `domains/${domain}`,
    message: `Missing required layer file(s): ${missing.join(', ')}`,
    fix:
      `Create the file(s). Python structural invariants for imports are deferred; completeness is enforced here.`,
  }];
}

// ---------------------------------------------------------------------------
// Invariant 6: Data access boundary — Supabase client only in repo + runtime
// ---------------------------------------------------------------------------

// Pattern: runtime calls `createClient(...)` as a VALUE (runtime executes the
// edge function entry). Importing `SupabaseClient` as a TYPE is not a
// violation — services often need the type to describe their parameters.
// We therefore flag:
//   - `import { createClient } from '...supabase-js...'` in any non-repo,
//     non-runtime file
//   - `import * as x from '...supabase-js...'` anywhere (conservative)

const SUPABASE_PKG_RE = /['"]npm:@supabase\/supabase-js[^'"]*['"]|['"]@supabase\/supabase-js['"]/;

const PROVIDERS_DATABASE_DIR = resolve(PROVIDERS_DIR, 'database');

function checkDataAccessBoundary(
  filePath: string,
  layer: Layer,
  domain: string,
  domainDir: string,
): Violation[] {
  // repo + runtime may access the data client
  if (layer === 'repo' || layer === 'runtime') return [];

  const content = readFileSync(filePath, 'utf-8');
  const fileLabel = `domains/${domain}/${relative(domainDir, filePath)}`;
  const violations: Violation[] = [];

  // Split import lines and flag ones with VALUE (non-type) bindings.
  // `import type { SupabaseClient } from '...'` is fine.
  // `import { createClient } from '...'` is a violation.
  const importRe =
    /import\s+(type\s+)?(?:(?:\{[^}]*\})|(?:\*\s+as\s+\w+)|(?:\w+))\s+from\s+(['"][^'"]+['"])/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(content)) !== null) {
    const isTypeOnly = Boolean(match[1]);
    const src = match[2];
    if (!SUPABASE_PKG_RE.test(src)) continue;
    if (isTypeOnly) continue;
    violations.push({
      category: 'DATA ACCESS BOUNDARY VIOLATION',
      file: fileLabel,
      message: `Imports Supabase client from ${src} but only repo and runtime may access it`,
      fix:
        `Move the query to repo.ts, or inject the client through the runtime handler and call it via the repo layer.`,
    });
  }

  // Block the indirect bypass: non-repo/non-runtime files may not reach the
  // data client through providers/database* either. Type-only imports are OK.
  for (const raw of parseImportPaths(filePath)) {
    if (!raw.startsWith('.')) continue;
    const resolved = resolve(dirname(filePath), raw);
    const isDatabaseProvider = resolved === PROVIDERS_DATABASE_DIR ||
      resolved.startsWith(PROVIDERS_DATABASE_DIR + sep) ||
      resolved === PROVIDERS_DATABASE_DIR + '.ts' ||
      resolved.startsWith(PROVIDERS_DATABASE_DIR + '.');
    if (!isDatabaseProvider) continue;
    // Skip `import type { ... } from '...providers/database...'`.
    const typeOnlyRe = new RegExp(
      `import\\s+type\\s+[^'"\`;]*from\\s+['"]${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
    );
    if (typeOnlyRe.test(content)) continue;
    violations.push({
      category: 'DATA ACCESS BOUNDARY VIOLATION',
      file: fileLabel,
      message:
        `Imports '${raw}' (providers/database) but only repo and runtime may reach the data client`,
      fix:
        `Move the query into repo.ts, or inject the provider through the runtime handler and call it via the repo layer.`,
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Invariant 7: Framework leak — Deno edge primitives only in runtime
// ---------------------------------------------------------------------------

const DENO_HTTP_RE = /['"]https:\/\/deno\.land\/std(?:@[^'"]+)?\/http\/server\.ts['"]/;
const DENO_SERVE_RE = /\bDeno\.serve\s*\(/;

function checkFrameworkLeak(
  filePath: string,
  layer: Layer,
  domain: string,
  domainDir: string,
): Violation[] {
  if (layer === 'runtime') return [];

  const content = readFileSync(filePath, 'utf-8');
  const fileLabel = `domains/${domain}/${relative(domainDir, filePath)}`;
  const violations: Violation[] = [];

  if (DENO_HTTP_RE.test(content)) {
    violations.push({
      category: 'FRAMEWORK LEAK',
      file: fileLabel,
      message: `Imports Deno std http server but ${layer} must be framework-agnostic`,
      fix: `Move the HTTP wiring to runtime.ts / handler.ts.`,
    });
  }
  if (DENO_SERVE_RE.test(content)) {
    violations.push({
      category: 'FRAMEWORK LEAK',
      file: fileLabel,
      message: `Calls Deno.serve(...) but ${layer} must be framework-agnostic`,
      fix: `Move the Deno.serve call into runtime.ts / handler.ts.`,
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Invariant 8: Circular imports within a domain
// ---------------------------------------------------------------------------

function checkCircularImports(domain: string, domainDir: string): Violation[] {
  const files = collectTsFiles(domainDir);
  // Build graph keyed by relative path (e.g. "service/handler.ts").
  const graph = new Map<string, string[]>();

  for (const file of files) {
    const key = relative(domainDir, file);
    const deps: string[] = [];
    for (const raw of parseImportPaths(file)) {
      if (!raw.startsWith('.')) continue;
      let resolved = resolve(dirname(file), raw);
      if (!resolved.endsWith('.ts')) {
        if (existsSync(resolved + '.ts')) resolved += '.ts';
        else if (existsSync(resolve(resolved, 'index.ts'))) {
          resolved = resolve(resolved, 'index.ts');
        }
      }
      // Only track edges to files in the same domain directory.
      if (!resolved.startsWith(domainDir + sep)) continue;
      const depKey = relative(domainDir, resolved);
      if (depKey !== key) deps.push(depKey);
    }
    graph.set(key, deps);
  }

  const violations: Violation[] = [];
  const seenCycleKeys = new Set<string>();

  function dfs(node: string, stack: string[], onStack: Set<string>): void {
    if (onStack.has(node)) {
      const startIdx = stack.indexOf(node);
      const cycle = [...stack.slice(startIdx), node];
      const key = [...new Set(cycle)].sort().join('|');
      if (seenCycleKeys.has(key)) return;
      seenCycleKeys.add(key);
      violations.push({
        category: 'CIRCULAR IMPORT',
        file: `domains/${domain}`,
        message: cycle.join(' → '),
        fix:
          `Break the cycle by moving shared logic to a lower layer or extracting it to a provider.`,
      });
      return;
    }
    if (stack.includes(node)) return;
    onStack.add(node);
    for (const n of graph.get(node) ?? []) {
      dfs(n, [...stack, node], onStack);
    }
    onStack.delete(node);
  }

  for (const node of graph.keys()) {
    dfs(node, [], new Set());
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Invariant 9: Wiring correctness
// ---------------------------------------------------------------------------

/**
 * For every edge-function entry in research/supabase/functions/<name>/,
 * verify its index.ts imports from ../../../domains/<name>/ (the layered
 * source) and never from a legacy flat location.
 *
 * Non-edge-function domains (benchmark-runner, benchmark-production, gepa)
 * are exempt: their runtime entry lives inside the domain itself.
 */
function checkWiring(domains: string[]): Violation[] {
  const violations: Violation[] = [];
  if (!existsSync(FUNCTIONS_DIR)) return violations;

  for (const domain of domains) {
    const indexFile = resolve(FUNCTIONS_DIR, domain, 'index.ts');
    if (!existsSync(indexFile)) continue; // domain has no edge-function wiring

    const content = readFileSync(indexFile, 'utf-8');
    const expectedPrefix = `../../../domains/${domain}/`;
    const domainImportRe = new RegExp(
      `from\\s+['"]\\.\\.\\/\\.\\.\\/\\.\\.\\/domains\\/${domain.replace(/-/g, '\\-')}\\/`,
    );
    if (!domainImportRe.test(content)) {
      violations.push({
        category: 'WIRING VIOLATION',
        file: `supabase/functions/${domain}/index.ts`,
        message:
          `Does not import from ${expectedPrefix}* — domain wiring is broken or points at legacy files`,
        fix: `Import the handler/runtime factory from ${expectedPrefix}runtime.ts or handler.ts.`,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function discoverDomains(): string[] {
  if (!existsSync(DOMAINS_DIR)) return [];
  return readdirSync(DOMAINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

const domains = discoverDomains();
if (domains.length === 0) {
  console.log('No domains found under research/domains/ — nothing to check.');
  process.exit(0);
}

console.log(`Scanning ${domains.length} domains under research/domains/...\n`);

for (const domain of domains) {
  const domainDir = resolve(DOMAINS_DIR, domain);
  console.log(`domains/${domain}`);

  if (PY_DOMAINS.has(domain)) {
    // Python domain: completeness only (import-direction checks TBD)
    runCheck('completeness (python)', checkDomainCompletenessPython(domain, domainDir));
    continue;
  }

  // TS domain: full invariant suite
  runCheck('completeness (ts)', checkDomainCompletenessTs(domain, domainDir));
  runCheck('no circular imports', checkCircularImports(domain, domainDir));

  const files = collectTsFiles(domainDir);
  for (const file of files) {
    const layer = classifyFile(file, domainDir);
    if (layer === null) continue; // uncategorised file, e.g. fixture
    const label = `${relative(domainDir, file)} (${layer})`;

    runCheck(`${label} layer deps`, checkLayerDeps(file, layer, domain, domainDir));
    runCheck(
      `${label} data access boundary`,
      checkDataAccessBoundary(file, layer, domain, domainDir),
    );
    runCheck(`${label} framework leak`, checkFrameworkLeak(file, layer, domain, domainDir));
  }
}

console.log('\n── Global boundary checks ──');
runCheck('providers/ never import from domains/', checkProviderBoundary());
runCheck('utils/ has zero research/ dependencies', checkUtilsBoundary());
runCheck('edge-function wiring points at domains/', checkWiring(domains));

console.log(`\n============================================================`);
console.log(`Results: ${passed} passed, ${failed} failed, ${totalChecks} total`);

if (failed > 0) {
  console.log(`\nAll violations:`);
  for (const v of allViolations) {
    console.log(`\n${v.category} in ${v.file}:`);
    console.log(`  ${v.message}`);
    console.log(`  → Fix: ${v.fix}`);
  }
  process.exit(1);
}

console.log('\nAll structural checks passed.');
process.exit(0);
