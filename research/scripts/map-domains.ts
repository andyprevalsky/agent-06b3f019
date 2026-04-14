#!/usr/bin/env tsx
/**
 * Maps research domains to their source files by tracing import graphs.
 *
 * Handles both TypeScript (Deno edge functions, benchmarks) and Python (GEPA pipeline).
 *
 * Usage:
 *   npx tsx research/scripts/map-domains.ts                # show all domains
 *   npx tsx research/scripts/map-domains.ts completions     # show one domain
 *   npx tsx research/scripts/map-domains.ts --json          # JSON output
 *   npx tsx research/scripts/map-domains.ts --classify      # shared file analysis
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { resolve, dirname, relative, extname, join } from 'path';

const RESEARCH = resolve(dirname(new URL(import.meta.url).pathname), '..');
const FUNCTIONS_DIR = resolve(RESEARCH, 'supabase/functions');
const BENCHMARKS_DIR = resolve(RESEARCH, 'benchmarks');
const GEPA_DIR = resolve(RESEARCH, 'gepa');
const TESTS_DIR = resolve(RESEARCH, 'tests');
const GEPA_TESTS_DIR = resolve(GEPA_DIR, 'tests');

// ---------------------------------------------------------------------------
// Import parsing
// ---------------------------------------------------------------------------

function parseTsLocalImports(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8');
  const imports: string[] = [];
  const regex = /(?:import|from)\s+['"](\.[^'"]+)['"]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const dir = dirname(filePath);
    let resolved = resolve(dir, match[1]);
    if (!resolved.endsWith('.ts') && !resolved.endsWith('.tsx') && !resolved.endsWith('.mjs')) {
      if (existsSync(resolved + '.ts')) resolved += '.ts';
      else if (existsSync(resolved + '.tsx')) resolved += '.tsx';
      else if (existsSync(resolve(resolved, 'index.ts'))) resolved = resolve(resolved, 'index.ts');
    }
    if (existsSync(resolved) && resolved.startsWith(RESEARCH)) {
      imports.push(resolved);
    }
  }
  return imports;
}

function parsePyLocalImports(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8');
  const imports: string[] = [];

  // 1. Relative imports: from .module import X / from ..module import X
  const relRegex = /^\s*from\s+(\.+[\w.]*)\s+import/gm;
  let match;
  while ((match = relRegex.exec(content)) !== null) {
    const importPath = match[1];
    for (const r of resolveRelativePyImport(filePath, importPath)) {
      if (existsSync(r) && r.startsWith(RESEARCH)) imports.push(r);
    }
  }

  // 2. Absolute imports within research: from research.gepa.X import Y
  const absRegex = /^\s*from\s+(research\.\w[\w.]*)\s+import/gm;
  while ((match = absRegex.exec(content)) !== null) {
    const modulePath = match[1];
    for (const r of resolveAbsolutePyImport(modulePath)) {
      if (existsSync(r) && r.startsWith(RESEARCH)) imports.push(r);
    }
  }

  return imports;
}

function resolveRelativePyImport(fromFile: string, importPath: string): string[] {
  let dots = 0;
  while (importPath[dots] === '.') dots++;
  const modulePart = importPath.slice(dots);

  let base = dirname(fromFile);
  for (let i = 1; i < dots; i++) base = dirname(base);

  const results: string[] = [];
  if (modulePart) {
    const target = resolve(base, ...modulePart.split('.'));
    if (existsSync(target + '.py')) results.push(target + '.py');
    if (existsSync(resolve(target, '__init__.py'))) results.push(resolve(target, '__init__.py'));
  } else {
    const init = resolve(base, '__init__.py');
    if (existsSync(init)) results.push(init);
  }
  return results;
}

function resolveAbsolutePyImport(modulePath: string): string[] {
  // research.gepa.scoring → <RESEARCH>/gepa/scoring/__init__.py or .py
  const parts = modulePath.split('.');
  // First part is "research" which maps to RESEARCH dir
  const projectRoot = dirname(RESEARCH);
  const target = resolve(projectRoot, ...parts);
  const results: string[] = [];
  if (existsSync(target + '.py')) results.push(target + '.py');
  if (existsSync(resolve(target, '__init__.py'))) results.push(resolve(target, '__init__.py'));
  return results;
}

function parseLocalImports(filePath: string): string[] {
  const ext = extname(filePath);
  if (['.ts', '.tsx', '.mjs'].includes(ext)) return parseTsLocalImports(filePath);
  if (ext === '.py') return parsePyLocalImports(filePath);
  return [];
}

// ---------------------------------------------------------------------------
// BFS import tracing
// ---------------------------------------------------------------------------

function traceImports(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const imp of parseLocalImports(file)) {
      if (!seen.has(imp)) queue.push(imp);
    }
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// Domain discovery
// ---------------------------------------------------------------------------

interface DomainInfo {
  domain: string;
  type: string;
  entryFile: string;
  files: string[];
  testFile: string | null;
  fileCount: number;
}

const domains: DomainInfo[] = [];

// 1. Edge Functions (type: "edge-function")
if (existsSync(FUNCTIONS_DIR)) {
  const fnDirs = readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();

  for (const fnName of fnDirs) {
    const entryFile = resolve(FUNCTIONS_DIR, fnName, 'index.ts');
    if (!existsSync(entryFile)) continue;

    const files = traceImports(entryFile).map(f => relative(RESEARCH, f));

    // Find test file in tests/
    let testFile: string | null = null;
    const candidates = [
      resolve(TESTS_DIR, `rose-${fnName}.test.ts`),
      resolve(TESTS_DIR, `${fnName}.test.ts`),
    ];
    if (fnName === 'rose-bench') {
      candidates.unshift(resolve(TESTS_DIR, 'rose-rose-bench.test.ts'));
      candidates.push(resolve(TESTS_DIR, 'rose-bench.test.ts'));
    }
    for (const tp of candidates) {
      if (existsSync(tp)) { testFile = relative(RESEARCH, tp); break; }
    }

    domains.push({
      domain: fnName,
      type: 'edge-function',
      entryFile: relative(RESEARCH, entryFile),
      files,
      testFile,
      fileCount: files.length,
    });
  }
}

// 2. Benchmarks (type: "benchmark")
if (existsSync(BENCHMARKS_DIR)) {
  const benchEntries: { name: string; file: string }[] = [
    { name: 'benchmark-runner', file: 'test-runner.ts' },
    { name: 'benchmark-production', file: 'run_production_benchmarks.ts' },
  ];
  for (const { name, file } of benchEntries) {
    const entry = resolve(BENCHMARKS_DIR, file);
    if (!existsSync(entry)) continue;
    const files = traceImports(entry).map(f => relative(RESEARCH, f));
    domains.push({
      domain: name,
      type: 'benchmark',
      entryFile: relative(RESEARCH, entry),
      files,
      testFile: null,
      fileCount: files.length,
    });
  }
}

// 3. GEPA Pipeline (type: "pipeline")
if (existsSync(GEPA_DIR)) {
  const gepaEntries: { name: string; file: string }[] = [
    { name: 'gepa', file: 'run.py' },
    { name: 'gepa-full-pipeline', file: 'run_full_pipeline.py' },
    { name: 'gepa-judge', file: 'run_judge.py' },
    { name: 'gepa-smoke', file: 'smoke_optimizer.py' },
  ];
  for (const { name, file } of gepaEntries) {
    const entry = resolve(GEPA_DIR, file);
    if (!existsSync(entry)) continue;
    const files = traceImports(entry).map(f => relative(RESEARCH, f));

    // Find matching test file
    let testFile: string | null = null;
    const slug = name.replace(/^gepa-?/, '').replace(/-/g, '_') || 'gepa_optimizer';
    const testPath = resolve(GEPA_TESTS_DIR, `test_${slug}.py`);
    if (existsSync(testPath)) testFile = relative(RESEARCH, testPath);

    domains.push({ domain: name, type: 'pipeline', entryFile: relative(RESEARCH, entry), files, testFile, fileCount: files.length });
  }
}

// 4. Root-level experiment scripts (type: "experiment")
const experiments = readdirSync(RESEARCH)
  .filter(f => f.startsWith('test_') && f.endsWith('.py'))
  .sort();

for (const script of experiments) {
  const entry = resolve(RESEARCH, script);
  const files = traceImports(entry).map(f => relative(RESEARCH, f));
  const name = script.replace('.py', '').replace(/^test_/, '').replace(/_/g, '-');
  domains.push({ domain: name, type: 'experiment', entryFile: relative(RESEARCH, entry), files, testFile: null, fileCount: files.length });
}

// ---------------------------------------------------------------------------
// Shared file classification
// ---------------------------------------------------------------------------

interface Classification {
  shared: { file: string; usedByCount: number; testFile: string | null; domains: string[] }[];
  appWiring: string[];
  domainOnly: Record<string, string>;
  orphaned: string[];
}

function collectSourceFiles(): Set<string> {
  const files = new Set<string>();
  function walk(dir: string, exts: string[]) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.git', '__pycache__', 'data', 'browser-use-repo', 'datasets', '.branches', '.temp'].includes(entry.name)) continue;
        walk(full, exts);
      } else if (exts.some(e => entry.name.endsWith(e)) && !entry.name.startsWith('test-') && !entry.name.startsWith('test_') && entry.name !== 'fixtures.py' && entry.name !== 'fixtures.ts') {
        files.add(relative(RESEARCH, full));
      }
    }
  }
  walk(resolve(RESEARCH, 'supabase/functions'), ['.ts']);
  walk(resolve(RESEARCH, 'benchmarks'), ['.ts']);
  walk(resolve(RESEARCH, 'gepa'), ['.py']);
  walk(resolve(RESEARCH, 'shared'), ['.ts']);
  return files;
}

function classifyFiles(): Classification {
  const allSource = collectSourceFiles();
  const fileDomains = new Map<string, string[]>();
  for (const d of domains) {
    for (const f of d.files) {
      if (!fileDomains.has(f)) fileDomains.set(f, []);
      fileDomains.get(f)!.push(d.domain);
    }
  }

  const shared: Classification['shared'] = [];
  const domainOnly: Record<string, string> = {};
  const orphaned: string[] = [];
  const appWiring = ['deploy.sh', 'run-local.sh', 'run-tests.sh'].filter(f => existsSync(resolve(RESEARCH, f)));

  for (const file of [...allSource].sort()) {
    const doms = fileDomains.get(file);
    if (!doms || doms.length === 0) {
      orphaned.push(file);
    } else if (doms.length === 1) {
      domainOnly[file] = doms[0];
    } else {
      shared.push({ file, usedByCount: doms.length, testFile: null, domains: doms });
    }
  }
  return { shared, appWiring, domainOnly, orphaned };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const arg = process.argv[2];

if (arg === '--json') {
  const classification = classifyFiles();
  console.log(JSON.stringify({ domains, classification }, null, 2));
  process.exit(0);
}

if (arg === '--classify') {
  const c = classifyFiles();
  console.log('Shared Files (used by 2+ domains):\n');
  if (c.shared.length === 0) {
    console.log('  (none)\n');
  } else {
    for (const s of c.shared) {
      console.log(`  ${s.file}`);
      console.log(`    Used by ${s.usedByCount} domains: ${s.domains.join(', ')}`);
    }
    console.log();
  }
  console.log('App Wiring:');
  for (const f of c.appWiring) console.log(`  ${f}`);
  console.log();
  console.log(`Domain-Only Files: ${Object.keys(c.domainOnly).length}`);
  console.log(`Orphaned Files: ${c.orphaned.length}`);
  if (c.orphaned.length > 0) {
    for (const f of c.orphaned) console.log(`  ${f}`);
  }
  process.exit(0);
}

if (arg && !arg.startsWith('-')) {
  const d = domains.find(x => x.domain === arg);
  if (!d) {
    console.error(`Unknown domain: ${arg}`);
    console.error(`Available: ${domains.map(x => x.domain).join(', ')}`);
    process.exit(1);
  }
  console.log(`Domain: ${d.domain}`);
  console.log(`Type:   ${d.type}`);
  console.log(`Entry:  ${d.entryFile}`);
  console.log(`Test:   ${d.testFile || '(none)'}`);
  console.log(`Files (${d.fileCount}):`);
  d.files.forEach(f => console.log(`  ${f}`));
  process.exit(0);
}

// Default: summary table grouped by type
const typeGroups = new Map<string, DomainInfo[]>();
for (const d of domains) {
  if (!typeGroups.has(d.type)) typeGroups.set(d.type, []);
  typeGroups.get(d.type)!.push(d);
}

console.log(`Research Domain Map (${domains.length} domains)\n`);
for (const [type, group] of typeGroups) {
  console.log(`  ${type.toUpperCase()} (${group.length}):`);
  for (const d of group) {
    const test = d.testFile ? 'has tests' : 'NO TESTS';
    console.log(`    ${d.domain.padEnd(28)} ${String(d.fileCount).padStart(3)} files  [${test}]`);
  }
  console.log();
}
console.log('Use: npx tsx research/scripts/map-domains.ts <domain> for details');
console.log('Use: npx tsx research/scripts/map-domains.ts --json for JSON output');
console.log('Use: npx tsx research/scripts/map-domains.ts --classify for shared file analysis');
