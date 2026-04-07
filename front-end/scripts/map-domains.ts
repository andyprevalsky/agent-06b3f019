#!/usr/bin/env tsx
/**
 * Maps frontend domains to their source files by tracing import graphs.
 *
 * Domain discovery strategy:
 *   - Pages (entry domains): src/pages/*.tsx — route entry points
 *   - Component groups (support domains): src/components/<dir>/ — co-located UI clusters
 *   - Contexts (support domains): src/contexts/*.tsx — state management
 *   - App wiring (coordination): App.tsx, main.tsx — composition root
 *
 * Shared infrastructure (not domains):
 *   - src/lib/          → providers + utils
 *   - src/hooks/        → shared hooks
 *   - src/components/ui/ → shared UI kit
 *   - src/data/         → static data
 *   - src/assets/       → images, animations
 *
 * Usage:
 *   npx tsx scripts/map-domains.ts              # summary table
 *   npx tsx scripts/map-domains.ts terminal      # one domain detail
 *   npx tsx scripts/map-domains.ts --json        # machine-readable JSON
 *   npx tsx scripts/map-domains.ts --classify    # shared file analysis
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { resolve, dirname, relative, basename, extname } from 'path';

// ── Paths ──────────────────────────────────────────────────────────────────
const FRONT_END = resolve(dirname(new URL(import.meta.url).pathname), '..');
const SRC = resolve(FRONT_END, 'src');
const PAGES_DIR = resolve(SRC, 'pages');
const COMPONENTS_DIR = resolve(SRC, 'components');
const CONTEXTS_DIR = resolve(SRC, 'contexts');
const HOOKS_DIR = resolve(SRC, 'hooks');
const LIB_DIR = resolve(SRC, 'lib');
const UI_DIR = resolve(COMPONENTS_DIR, 'ui');
const DATA_DIR = resolve(SRC, 'data');

// ── Import parsing ─────────────────────────────────────────────────────────
const TS_EXTENSIONS = ['.ts', '.tsx'];

function resolveImportPath(importSpec: string, fromDir: string): string | null {
  // Handle @/ alias → src/
  let target: string;
  if (importSpec.startsWith('@/')) {
    target = resolve(SRC, importSpec.slice(2));
  } else if (importSpec.startsWith('.')) {
    target = resolve(fromDir, importSpec);
  } else {
    return null; // external package
  }

  // Try exact path, then with extensions, then as directory with index
  if (existsSync(target) && statSync(target).isFile()) return target;
  for (const ext of TS_EXTENSIONS) {
    if (existsSync(target + ext)) return target + ext;
  }
  if (existsSync(target) && statSync(target).isDirectory()) {
    for (const ext of TS_EXTENSIONS) {
      const idx = resolve(target, 'index' + ext);
      if (existsSync(idx)) return idx;
    }
  }
  return null;
}

function parseLocalImports(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8');
  const imports: string[] = [];
  // Match: import ... from 'x', import 'x', export ... from 'x'
  const regex = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const resolved = resolveImportPath(match[1], dirname(filePath));
    if (resolved && resolved.startsWith(SRC)) {
      imports.push(resolved);
    }
  }
  return imports;
}

// ── Import graph tracing ───────────────────────────────────────────────────
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

// ── Shared infrastructure detection ────────────────────────────────────────
function isSharedFile(absPath: string): boolean {
  const rel = relative(SRC, absPath);
  return (
    rel.startsWith('lib/') ||
    rel.startsWith('hooks/') ||
    rel.startsWith('components/ui/') ||
    rel.startsWith('data/') ||
    rel.startsWith('assets/') ||
    rel === 'vite-env.d.ts'
  );
}

function classifySharedFile(absPath: string): string {
  const rel = relative(SRC, absPath);
  if (rel.startsWith('lib/')) {
    // Provider vs util: check for side effects (fetch, env vars, new instances)
    const content = existsSync(absPath) ? readFileSync(absPath, 'utf-8') : '';
    const hasSideEffects = /\b(fetch|axios|createClient|import\.meta\.env|new |addEventListener|window\.|document\.)\b/.test(content);
    return hasSideEffects ? 'shared/lib (provider)' : 'shared/lib (util)';
  }
  if (rel.startsWith('hooks/')) return 'shared/hooks';
  if (rel.startsWith('components/ui/')) return 'shared/ui';
  if (rel.startsWith('data/')) return 'shared/data';
  if (rel.startsWith('assets/')) return 'shared/assets';
  return 'shared/other';
}

// ── Domain discovery ───────────────────────────────────────────────────────
interface DomainInfo {
  domain: string;
  type: 'page' | 'component-group' | 'context' | 'coordination';
  entryFile: string;
  files: string[];
  testFile: string | null;
  fileCount: number;
}

function findTestFile(domainName: string): string | null {
  // Check common test locations
  const candidates = [
    resolve(SRC, 'tests', `${domainName}.test.ts`),
    resolve(SRC, 'tests', `${domainName}.test.tsx`),
    resolve(SRC, 'tests', 'blackbox', `${domainName}.blackbox.ts`),
    resolve(SRC, 'tests', 'blackbox', `${domainName}.blackbox.tsx`),
    resolve(SRC, '__tests__', `${domainName}.test.ts`),
    resolve(SRC, '__tests__', `${domainName}.test.tsx`),
    resolve(FRONT_END, 'tests', `${domainName}.test.ts`),
    resolve(FRONT_END, 'tests', `${domainName}.test.tsx`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return relative(FRONT_END, c);
  }
  return null;
}

function discoverDomains(): DomainInfo[] {
  const domains: DomainInfo[] = [];

  // 1. Pages (entry domains) — each page is a route entry point
  if (existsSync(PAGES_DIR)) {
    const pageFiles = readdirSync(PAGES_DIR)
      .filter(f => TS_EXTENSIONS.some(ext => f.endsWith(ext)))
      .sort();
    for (const file of pageFiles) {
      const name = basename(file, extname(file));
      const domainName = toKebab(name);
      const entryPath = resolve(PAGES_DIR, file);
      const allFiles = traceImports(entryPath);
      const domainFiles = allFiles.map(f => relative(FRONT_END, f));
      domains.push({
        domain: domainName,
        type: 'page',
        entryFile: relative(FRONT_END, entryPath),
        files: domainFiles,
        testFile: findTestFile(domainName),
        fileCount: domainFiles.length,
      });
    }
  }

  // 2. Component groups (support domains) — subdirs of components/ (except ui/)
  if (existsSync(COMPONENTS_DIR)) {
    const componentDirs = readdirSync(COMPONENTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== 'ui' && d.name !== 'Users')
      .map(d => d.name)
      .sort();
    for (const dir of componentDirs) {
      const dirPath = resolve(COMPONENTS_DIR, dir);
      // Find all source files in this group
      const sourceFiles = readdirSync(dirPath)
        .filter(f => TS_EXTENSIONS.some(ext => f.endsWith(ext)))
        .sort();
      if (sourceFiles.length === 0) continue;

      // Entry = index.ts(x) if exists, otherwise first file
      const indexFile = sourceFiles.find(f => f.startsWith('index.'));
      const entryFile = indexFile
        ? resolve(dirPath, indexFile)
        : resolve(dirPath, sourceFiles[0]);

      // Trace imports from ALL files in the group (they form one domain)
      const allFiles = new Set<string>();
      for (const f of sourceFiles) {
        for (const traced of traceImports(resolve(dirPath, f))) {
          allFiles.add(traced);
        }
      }
      const domainFiles = [...allFiles].sort().map(f => relative(FRONT_END, f));

      domains.push({
        domain: dir,
        type: 'component-group',
        entryFile: relative(FRONT_END, entryFile),
        files: domainFiles,
        testFile: findTestFile(dir),
        fileCount: domainFiles.length,
      });
    }
  }

  // 3. Contexts (support domains)
  if (existsSync(CONTEXTS_DIR)) {
    const contextFiles = readdirSync(CONTEXTS_DIR)
      .filter(f => TS_EXTENSIONS.some(ext => f.endsWith(ext)))
      .sort();
    for (const file of contextFiles) {
      const name = basename(file, extname(file));
      const domainName = toKebab(name);
      const entryPath = resolve(CONTEXTS_DIR, file);
      const allFiles = traceImports(entryPath);
      const domainFiles = allFiles.map(f => relative(FRONT_END, f));
      domains.push({
        domain: domainName,
        type: 'context',
        entryFile: relative(FRONT_END, entryPath),
        files: domainFiles,
        testFile: findTestFile(domainName),
        fileCount: domainFiles.length,
      });
    }
  }

  // 4. App wiring (coordination domain)
  const appFile = resolve(SRC, 'App.tsx');
  const mainFile = resolve(SRC, 'main.tsx');
  if (existsSync(appFile)) {
    const appFiles = new Set<string>();
    for (const f of traceImports(appFile)) appFiles.add(f);
    if (existsSync(mainFile)) {
      for (const f of traceImports(mainFile)) appFiles.add(f);
    }
    const domainFiles = [...appFiles].sort().map(f => relative(FRONT_END, f));
    domains.push({
      domain: 'app-wiring',
      type: 'coordination',
      entryFile: relative(FRONT_END, appFile),
      files: domainFiles,
      testFile: findTestFile('app-wiring'),
      fileCount: domainFiles.length,
    });
  }

  return domains;
}

// ── Classification ─────────────────────────────────────────────────────────
interface Classification {
  shared: { file: string; category: string; usedByCount: number; testFile: string | null }[];
  appWiring: string[];
  domainOnly: Record<string, string>;
  orphaned: string[];
}

function classifyFiles(domains: DomainInfo[]): Classification {
  // Build file→domain usage map
  const fileUsage = new Map<string, Set<string>>();
  for (const d of domains) {
    for (const f of d.files) {
      if (!fileUsage.has(f)) fileUsage.set(f, new Set());
      fileUsage.get(f)!.add(d.domain);
    }
  }

  // Collect all source files in src/
  const allSrcFiles = new Set<string>();
  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else if (TS_EXTENSIONS.some(ext => entry.name.endsWith(ext))) {
        allSrcFiles.add(relative(FRONT_END, full));
      }
    }
  }
  walk(SRC);

  const shared: Classification['shared'] = [];
  const domainOnly: Record<string, string> = {};
  const orphaned: string[] = [];
  const appWiring = ['src/App.tsx', 'src/main.tsx'].filter(f => existsSync(resolve(FRONT_END, f)));

  for (const relFile of [...allSrcFiles].sort()) {
    const absFile = resolve(FRONT_END, relFile);
    const usage = fileUsage.get(relFile);

    if (isSharedFile(absFile)) {
      shared.push({
        file: relFile,
        category: classifySharedFile(absFile),
        usedByCount: usage ? usage.size : 0,
        testFile: null,
      });
    } else if (appWiring.includes(relFile)) {
      // skip — already in appWiring
    } else if (!usage || usage.size === 0) {
      orphaned.push(relFile);
    } else if (usage.size === 1) {
      domainOnly[relFile] = [...usage][0];
    }
    // files used by 2+ domains are shared by usage (but not in shared/ dir)
  }

  return { shared, appWiring, domainOnly, orphaned };
}

// ── Helpers ────────────────────────────────────────────────────────────────
function toKebab(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

const TYPE_LABELS: Record<DomainInfo['type'], string> = {
  'page': 'Page (entry)',
  'component-group': 'Component Group (support)',
  'context': 'Context (support)',
  'coordination': 'Coordination',
};

// ── Output modes ───────────────────────────────────────────────────────────
const domains = discoverDomains();
const arg = process.argv[2];

if (arg === '--json') {
  const classification = classifyFiles(domains);
  const output = {
    domains: domains.map(d => ({
      domain: d.domain,
      type: d.type,
      entryFile: d.entryFile,
      files: d.files,
      testFile: d.testFile,
      fileCount: d.fileCount,
    })),
    classification,
  };
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

if (arg === '--classify') {
  const classification = classifyFiles(domains);

  console.log('═══ Shared Infrastructure ═══\n');
  const byCategory = new Map<string, typeof classification.shared>();
  for (const s of classification.shared) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, []);
    byCategory.get(s.category)!.push(s);
  }
  for (const [cat, files] of [...byCategory.entries()].sort()) {
    console.log(`  ${cat} (${files.length} files):`);
    for (const f of files) {
      console.log(`    ${f.file}  [used by ${f.usedByCount} domain(s)]`);
    }
    console.log();
  }

  console.log('═══ App Wiring ═══\n');
  for (const f of classification.appWiring) {
    console.log(`  ${f}`);
  }

  console.log('\n═══ Orphaned Files (not in any import graph) ═══\n');
  if (classification.orphaned.length === 0) {
    console.log('  (none)');
  } else {
    for (const f of classification.orphaned) {
      console.log(`  ${f}`);
    }
  }
  console.log();
  process.exit(0);
}

if (arg && arg !== '--json' && arg !== '--classify') {
  const d = domains.find(x => x.domain === arg);
  if (!d) {
    console.error(`Unknown domain: ${arg}`);
    console.error(`Available: ${domains.map(x => x.domain).join(', ')}`);
    process.exit(1);
  }
  console.log(`Domain: ${d.domain}`);
  console.log(`Type:   ${TYPE_LABELS[d.type]}`);
  console.log(`Entry:  ${d.entryFile}`);
  console.log(`Test:   ${d.testFile || '(none)'}`);
  console.log(`Files (${d.fileCount}):`);
  d.files.forEach(f => {
    const abs = resolve(FRONT_END, f);
    const tag = isSharedFile(abs) ? ' [shared]' : '';
    console.log(`  ${f}${tag}`);
  });
  process.exit(0);
}

// Default: summary table
console.log(`Frontend Domain Map (${domains.length} domains)\n`);

const grouped = new Map<string, DomainInfo[]>();
for (const d of domains) {
  const label = TYPE_LABELS[d.type];
  if (!grouped.has(label)) grouped.set(label, []);
  grouped.get(label)!.push(d);
}

for (const [typeLabel, typeDomains] of grouped) {
  console.log(`── ${typeLabel} ──`);
  for (const d of typeDomains) {
    const test = d.testFile ? 'has tests' : 'NO TESTS';
    console.log(`  ${d.domain.padEnd(40)} ${String(d.fileCount).padStart(3)} files  [${test}]`);
  }
  console.log();
}

console.log(`Use: npx tsx scripts/map-domains.ts <domain> for details`);
console.log(`Use: npx tsx scripts/map-domains.ts --json for machine-readable output`);
console.log(`Use: npx tsx scripts/map-domains.ts --classify for shared file analysis`);
