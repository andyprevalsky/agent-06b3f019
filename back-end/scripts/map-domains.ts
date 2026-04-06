#!/usr/bin/env tsx
/**
 * Maps backend domains to their source files by tracing import graphs.
 *
 * Usage:
 *   npx tsx scripts/map-domains.ts              # show all domains
 *   npx tsx scripts/map-domains.ts agents        # show one domain
 *   npx tsx scripts/map-domains.ts --json        # JSON output
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname, relative } from 'path';

const BACK_END = resolve(dirname(new URL(import.meta.url).pathname), '..');
const SRC = resolve(BACK_END, 'src');
const DOMAINS_DIR = resolve(SRC, 'domains');
const BLACKBOX_DIR = resolve(SRC, 'tests/blackbox');

function parseLocalImports(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8');
  const imports: string[] = [];
  const regex = /(?:import|from)\s+['"](\.[^'"]+)['"]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const dir = dirname(filePath);
    let resolved = resolve(dir, match[1]);
    if (!resolved.endsWith('.ts') && existsSync(resolved + '.ts')) resolved += '.ts';
    else if (existsSync(resolved + '/index.ts')) resolved += '/index.ts';
    if (existsSync(resolved) && resolved.startsWith(SRC)) {
      imports.push(resolved);
    }
  }
  return imports;
}

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

interface DomainInfo {
  domain: string;
  entryFile: string;
  files: string[];
  testFile: string | null;
  fileCount: number;
}

const domainDirs = readdirSync(DOMAINS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();
const domains: DomainInfo[] = [];

for (const domainName of domainDirs) {
  const domainDir = resolve(DOMAINS_DIR, domainName);
  // Find all routes*.ts files in this domain directory
  const routeFiles = readdirSync(domainDir)
    .filter(f => f.startsWith('routes') && f.endsWith('.ts'))
    .sort();
  if (routeFiles.length === 0) continue;

  // Use the primary routes.ts as entry, but trace all route files
  const entryFiles = routeFiles.map(f => resolve(domainDir, f));
  const allFiles = new Set<string>();
  for (const entry of entryFiles) {
    for (const f of traceImports(entry)) allFiles.add(f);
  }
  const sortedFiles = [...allFiles].sort().map(f => relative(BACK_END, f));

  const testFilename = `${domainName}.blackbox.ts`;
  const testPath = resolve(BLACKBOX_DIR, testFilename);

  domains.push({
    domain: domainName,
    entryFile: relative(BACK_END, entryFiles.find(f => f.endsWith('/routes.ts')) ?? entryFiles[0]),
    files: sortedFiles,
    testFile: existsSync(testPath) ? relative(BACK_END, testPath) : null,
    fileCount: sortedFiles.length,
  });
}

const arg = process.argv[2];

if (arg === '--json') {
  console.log(JSON.stringify(domains, null, 2));
  process.exit(0);
}

if (arg && arg !== '--json') {
  const d = domains.find(x => x.domain === arg);
  if (!d) {
    console.error(`Unknown domain: ${arg}`);
    console.error(`Available: ${domains.map(x => x.domain).join(', ')}`);
    process.exit(1);
  }
  console.log(`Domain: ${d.domain}`);
  console.log(`Entry:  ${d.entryFile}`);
  console.log(`Test:   ${d.testFile || '(none)'}`);
  console.log(`Files (${d.fileCount}):`);
  d.files.forEach(f => console.log(`  ${f}`));
  process.exit(0);
}

console.log(`Backend Domain Map (${domains.length} domains)\n`);
for (const d of domains) {
  const test = d.testFile ? 'has tests' : 'NO TESTS';
  console.log(`  ${d.domain.padEnd(25)} ${String(d.fileCount).padStart(3)} files  [${test}]`);
}
console.log(`\nUse: npx tsx scripts/map-domains.ts <domain> for details`);
console.log(`Use: npx tsx scripts/map-domains.ts --json for machine-readable output`);
