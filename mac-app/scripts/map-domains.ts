#!/usr/bin/env tsx
/**
 * Maps mac-app (Electron) domains to their source files by tracing import graphs.
 *
 * The mac-app has three process/context layers:
 *   - main/    → Electron main process (Node side)
 *   - ui/      → React renderer process (browser context)
 *   - shared/  → Types shared between main and UI
 *
 * Domain discovery strategy:
 *   Main process (Node):
 *     - handlers/registry.ts  → IPC entry (coordination)
 *     - services/<name>.ts    → service support domains
 *     - services/messaging/platforms/<platform>/ → messaging platform domains (support)
 *     - services/sync/SyncManager.ts → sync coordination
 *     - services/messaging/index.ts  → messaging coordination (MessageTransformer)
 *     - main/index.ts, main/preload.ts → Electron app wiring
 *   Renderer (React):
 *     - ui/ElectronApp.tsx, ui/UpdateIndicator.tsx → top-level renderer surfaces (entry)
 *     - ui/onboarding/Onboarding.tsx → onboarding flow (entry)
 *     - ui/launcher/main.tsx → launcher window (entry)
 *     - ui/components/<Modal>.tsx → modal component groups (support)
 *     - ui/main.tsx → renderer composition root (coordination)
 *
 * Shared infrastructure (not domains):
 *   - main/base/       → providers + utils (config, logger, crypto)
 *   - shared/types/    → cross-process IPC/shared types
 *   - `@/*` imports    → front-end package (not resolved locally)
 *
 * Usage:
 *   npx tsx scripts/map-domains.ts              # summary table
 *   npx tsx scripts/map-domains.ts <domain>     # one domain detail
 *   npx tsx scripts/map-domains.ts --json       # machine-readable JSON
 *   npx tsx scripts/map-domains.ts --classify   # shared file analysis
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { resolve, dirname, relative, basename, extname } from 'path';

// ── Paths ──────────────────────────────────────────────────────────────────
const MAC_APP = resolve(dirname(new URL(import.meta.url).pathname), '..');
const MAIN = resolve(MAC_APP, 'main');
const UI = resolve(MAC_APP, 'ui');
const SHARED = resolve(MAC_APP, 'shared');
const HANDLERS_DIR = resolve(MAIN, 'handlers');
const SERVICES_DIR = resolve(MAIN, 'services');
const BASE_DIR = resolve(MAIN, 'base');
const PLATFORMS_DIR = resolve(SERVICES_DIR, 'messaging', 'platforms');
const UI_COMPONENTS_DIR = resolve(UI, 'components');
const UI_ONBOARDING_DIR = resolve(UI, 'onboarding');
const UI_LAUNCHER_DIR = resolve(UI, 'launcher');

// ── Import parsing ─────────────────────────────────────────────────────────
const TS_EXTENSIONS = ['.ts', '.tsx'];

function resolveImportPath(importSpec: string, fromDir: string): string | null {
  // @/ and @shared/ aliases point into ../front-end/src — treat as external
  if (importSpec.startsWith('@/') || importSpec.startsWith('@shared/')) return null;
  if (!importSpec.startsWith('.') && !importSpec.startsWith('/')) return null;

  const target = importSpec.startsWith('.') ? resolve(fromDir, importSpec) : importSpec;

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
  const staticRegex = /(?:import|export)\s*(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  // Match: import('x') dynamic imports
  const dynamicRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const regex of [staticRegex, dynamicRegex]) {
    let match;
    while ((match = regex.exec(content)) !== null) {
      // Statement-level `import type ... from 'x'` / `export type ... from 'x'`
      // are erased by the compiler and load nothing at runtime, so tracing them
      // inflates a domain's closure with modules it never executes — one
      // `import type` of a service barrel dragged every reader implementation
      // into browser-state-sync. Inline specifiers (`import { type T, fn }`)
      // still emit a real import and are deliberately still traced.
      if (/^(?:import|export)\s+type\s/.test(match[0])) continue;
      const resolved = resolveImportPath(match[1], dirname(filePath));
      if (resolved && resolved.startsWith(MAC_APP)) {
        imports.push(resolved);
      }
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
  const rel = relative(MAC_APP, absPath);
  return rel.startsWith('main/base/') || rel.startsWith('main/types/') || rel.startsWith('shared/');
}

function classifySharedFile(absPath: string): string {
  const rel = relative(MAC_APP, absPath);
  if (rel.startsWith('main/base/')) {
    const content = existsSync(absPath) ? readFileSync(absPath, 'utf-8') : '';
    // Providers: touch env, filesystem, network, Electron APIs, or instantiate clients
    const hasSideEffects =
      /\b(process\.env|fs\.|fetch|axios|createClient|new\s+[A-Z]|app\.|BrowserWindow|ipcMain|require\(|readFileSync|writeFileSync)\b/.test(
        content
      );
    return hasSideEffects ? 'main/base (provider)' : 'main/base (util)';
  }
  if (rel.startsWith('main/types/')) return 'main/types';
  if (rel.startsWith('shared/types/')) return 'shared/types';
  if (rel.startsWith('shared/')) return 'shared/other';
  return 'shared/other';
}

// ── Domain discovery ───────────────────────────────────────────────────────
interface DomainInfo {
  domain: string;
  type:
    | 'main-entry'
    | 'main-service'
    | 'main-platform'
    | 'main-coordination'
    | 'main-wiring'
    | 'renderer-entry'
    | 'renderer-modal'
    | 'renderer-coordination';
  entryFile: string;
  files: string[];
  testFile: string | null;
  fileCount: number;
}

function findTestFile(domainName: string): string | null {
  const candidates = [
    resolve(MAC_APP, 'tests', `${domainName}.test.ts`),
    resolve(MAC_APP, 'tests', `${domainName}.test.tsx`),
    resolve(MAC_APP, 'tests', 'blackbox', `${domainName}.blackbox.ts`),
    resolve(MAC_APP, 'tests', 'blackbox', `${domainName}.blackbox.tsx`),
    resolve(MAC_APP, '__tests__', `${domainName}.test.ts`),
    resolve(MAIN, 'tests', `${domainName}.test.ts`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return relative(MAC_APP, c);
  }
  return null;
}

function sourceFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => TS_EXTENSIONS.some((ext) => f.endsWith(ext)))
    .sort();
}

function traceGroup(files: string[]): string[] {
  const all = new Set<string>();
  for (const f of files) {
    for (const t of traceImports(f)) all.add(t);
  }
  return [...all].sort();
}

function discoverDomains(): DomainInfo[] {
  const domains: DomainInfo[] = [];

  // ── Main process domains ────────────────────────────────────────────────

  // 1. IPC handler registry — the coordination entry point from renderer
  const registryEntry = resolve(HANDLERS_DIR, 'registry.ts');
  if (existsSync(registryEntry)) {
    const files = traceImports(registryEntry).map((f) => relative(MAC_APP, f));
    domains.push({
      domain: 'ipc-registry',
      type: 'main-entry',
      entryFile: relative(MAC_APP, registryEntry),
      files,
      testFile: findTestFile('ipc-registry'),
      fileCount: files.length,
    });
  }

  // 2. Top-level service files — each is a support domain
  if (existsSync(SERVICES_DIR)) {
    const topServiceFiles = sourceFilesIn(SERVICES_DIR);
    for (const file of topServiceFiles) {
      const name = basename(file, extname(file));
      // Skip pure interface files (IMessageQueueService is an interface, still a domain)
      const domainName = toKebab(name);
      const entryPath = resolve(SERVICES_DIR, file);
      // Several `services/<name>.ts` files are re-export shims exposing only
      // part of their domain (passkeyEnroll re-exports config + repo but NOT
      // the enrollment service, which handlers import directly). Tracing the
      // shim alone silently truncates the closure and lets a domain-scoped gate
      // skip the real code path, so union in the matching domain service when
      // one exists.
      const domainServicePath = resolve(MAIN, 'domains', domainName, 'service.ts');
      const entryPoints = existsSync(domainServicePath)
        ? [entryPath, domainServicePath]
        : [entryPath];
      const files = [...new Set(entryPoints.flatMap((entry) => traceImports(entry)))]
        .map((f) => relative(MAC_APP, f))
        .sort();
      domains.push({
        domain: domainName,
        type: 'main-service',
        entryFile: relative(MAC_APP, entryPath),
        files,
        testFile: findTestFile(domainName),
        fileCount: files.length,
      });
    }
  }

  // 3. Messaging platform domains (services/messaging/platforms/<platform>)
  if (existsSync(PLATFORMS_DIR)) {
    const platformDirs = readdirSync(PLATFORMS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const plat of platformDirs) {
      const platDir = resolve(PLATFORMS_DIR, plat);
      const platFiles = sourceFilesIn(platDir);
      if (platFiles.length === 0) continue;
      const indexFile = platFiles.find((f) => f.startsWith('index.'));
      const entryPath = indexFile ? resolve(platDir, indexFile) : resolve(platDir, platFiles[0]);
      const files = traceGroup(platFiles.map((f) => resolve(platDir, f))).map((f) =>
        relative(MAC_APP, f)
      );
      domains.push({
        domain: `messaging-${plat}`,
        type: 'main-platform',
        entryFile: relative(MAC_APP, entryPath),
        files,
        testFile: findTestFile(`messaging-${plat}`),
        fileCount: files.length,
      });
    }
  }

  // 4. Messaging coordination (MessageTransformer + index.ts barrel)
  const messagingRoot = resolve(SERVICES_DIR, 'messaging');
  if (existsSync(messagingRoot)) {
    const topFiles = sourceFilesIn(messagingRoot);
    if (topFiles.length > 0) {
      const indexFile = topFiles.find((f) => f === 'index.ts' || f === 'index.tsx');
      const entryPath = indexFile
        ? resolve(messagingRoot, indexFile)
        : resolve(messagingRoot, topFiles[0]);
      const files = traceGroup(topFiles.map((f) => resolve(messagingRoot, f))).map((f) =>
        relative(MAC_APP, f)
      );
      domains.push({
        domain: 'messaging-core',
        type: 'main-coordination',
        entryFile: relative(MAC_APP, entryPath),
        files,
        testFile: findTestFile('messaging-core'),
        fileCount: files.length,
      });
    }
  }

  // 5. Sync coordination (services/sync/)
  const syncRoot = resolve(SERVICES_DIR, 'sync');
  if (existsSync(syncRoot)) {
    const syncFiles = sourceFilesIn(syncRoot);
    if (syncFiles.length > 0) {
      const indexFile =
        syncFiles.find((f) => f.startsWith('index.')) ||
        syncFiles.find((f) => f === 'SyncManager.ts');
      const entryPath = indexFile ? resolve(syncRoot, indexFile) : resolve(syncRoot, syncFiles[0]);
      const files = traceGroup(syncFiles.map((f) => resolve(syncRoot, f))).map((f) =>
        relative(MAC_APP, f)
      );
      domains.push({
        domain: 'sync-manager',
        type: 'main-coordination',
        entryFile: relative(MAC_APP, entryPath),
        files,
        testFile: findTestFile('sync-manager'),
        fileCount: files.length,
      });
    }
  }

  // 6. Main process app wiring — Electron entry + preload bridge
  const mainIndex = resolve(MAIN, 'index.ts');
  if (existsSync(mainIndex)) {
    const files = traceImports(mainIndex).map((f) => relative(MAC_APP, f));
    domains.push({
      domain: 'electron-main',
      type: 'main-wiring',
      entryFile: relative(MAC_APP, mainIndex),
      files,
      testFile: findTestFile('electron-main'),
      fileCount: files.length,
    });
  }
  const preload = resolve(MAIN, 'preload.ts');
  if (existsSync(preload)) {
    const files = traceImports(preload).map((f) => relative(MAC_APP, f));
    domains.push({
      domain: 'electron-preload',
      type: 'main-wiring',
      entryFile: relative(MAC_APP, preload),
      files,
      testFile: findTestFile('electron-preload'),
      fileCount: files.length,
    });
  }

  // ── Renderer domains ────────────────────────────────────────────────────

  // 7. Top-level renderer surfaces (ui/*.tsx at root, excluding main.tsx)
  if (existsSync(UI)) {
    const uiTopFiles = sourceFilesIn(UI).filter((f) => f !== 'main.tsx' && !f.endsWith('.d.ts'));
    for (const file of uiTopFiles) {
      const name = basename(file, extname(file));
      const domainName = toKebab(name);
      const entryPath = resolve(UI, file);
      const files = traceImports(entryPath).map((f) => relative(MAC_APP, f));
      domains.push({
        domain: domainName,
        type: 'renderer-entry',
        entryFile: relative(MAC_APP, entryPath),
        files,
        testFile: findTestFile(domainName),
        fileCount: files.length,
      });
    }
  }

  // 8. Onboarding flow (ui/onboarding/) — entry domain with multiple components
  if (existsSync(UI_ONBOARDING_DIR)) {
    const onboardingFiles = sourceFilesIn(UI_ONBOARDING_DIR);
    if (onboardingFiles.length > 0) {
      const entryFile = onboardingFiles.find((f) => f === 'Onboarding.tsx') || onboardingFiles[0];
      const entryPath = resolve(UI_ONBOARDING_DIR, entryFile);
      const files = traceGroup(onboardingFiles.map((f) => resolve(UI_ONBOARDING_DIR, f))).map((f) =>
        relative(MAC_APP, f)
      );
      domains.push({
        domain: 'onboarding',
        type: 'renderer-entry',
        entryFile: relative(MAC_APP, entryPath),
        files,
        testFile: findTestFile('onboarding'),
        fileCount: files.length,
      });
    }
  }

  // 9. Launcher window (ui/launcher/)
  if (existsSync(UI_LAUNCHER_DIR)) {
    const launcherFiles = sourceFilesIn(UI_LAUNCHER_DIR);
    if (launcherFiles.length > 0) {
      const entryFile = launcherFiles.find((f) => f === 'main.tsx') || launcherFiles[0];
      const entryPath = resolve(UI_LAUNCHER_DIR, entryFile);
      const files = traceGroup(launcherFiles.map((f) => resolve(UI_LAUNCHER_DIR, f))).map((f) =>
        relative(MAC_APP, f)
      );
      domains.push({
        domain: 'launcher',
        type: 'renderer-entry',
        entryFile: relative(MAC_APP, entryPath),
        files,
        testFile: findTestFile('launcher'),
        fileCount: files.length,
      });
    }
  }

  // 10. Modal components (ui/components/) — each is a support domain
  if (existsSync(UI_COMPONENTS_DIR)) {
    const modalFiles = sourceFilesIn(UI_COMPONENTS_DIR);
    for (const file of modalFiles) {
      const name = basename(file, extname(file));
      const domainName = toKebab(name);
      const entryPath = resolve(UI_COMPONENTS_DIR, file);
      const files = traceImports(entryPath).map((f) => relative(MAC_APP, f));
      domains.push({
        domain: domainName,
        type: 'renderer-modal',
        entryFile: relative(MAC_APP, entryPath),
        files,
        testFile: findTestFile(domainName),
        fileCount: files.length,
      });
    }
  }

  // 11. Renderer composition root (ui/main.tsx)
  const rendererMain = resolve(UI, 'main.tsx');
  if (existsSync(rendererMain)) {
    const files = traceImports(rendererMain).map((f) => relative(MAC_APP, f));
    domains.push({
      domain: 'renderer-main',
      type: 'renderer-coordination',
      entryFile: relative(MAC_APP, rendererMain),
      files,
      testFile: findTestFile('renderer-main'),
      fileCount: files.length,
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

function walkSource(dir: string, out: Set<string>): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      walkSource(full, out);
    } else if (TS_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.add(relative(MAC_APP, full));
    }
  }
}

function classifyFiles(domains: DomainInfo[]): Classification {
  const fileUsage = new Map<string, Set<string>>();
  for (const d of domains) {
    for (const f of d.files) {
      if (!fileUsage.has(f)) fileUsage.set(f, new Set());
      fileUsage.get(f)!.add(d.domain);
    }
  }

  const allSrcFiles = new Set<string>();
  walkSource(MAIN, allSrcFiles);
  walkSource(UI, allSrcFiles);
  walkSource(SHARED, allSrcFiles);

  const shared: Classification['shared'] = [];
  const domainOnly: Record<string, string> = {};
  const orphaned: string[] = [];
  const appWiring = ['main/index.ts', 'main/preload.ts', 'ui/main.tsx'].filter((f) =>
    existsSync(resolve(MAC_APP, f))
  );

  for (const relFile of [...allSrcFiles].sort()) {
    const absFile = resolve(MAC_APP, relFile);
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
    // files used by 2+ domains: implicit shared by usage
  }

  return { shared, appWiring, domainOnly, orphaned };
}

// ── Helpers ────────────────────────────────────────────────────────────────
function toKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

const TYPE_LABELS: Record<DomainInfo['type'], string> = {
  'main-entry': 'Main — IPC Entry',
  'main-service': 'Main — Service (support)',
  'main-platform': 'Main — Messaging Platform',
  'main-coordination': 'Main — Coordination',
  'main-wiring': 'Main — App Wiring',
  'renderer-entry': 'Renderer — Entry',
  'renderer-modal': 'Renderer — Modal (support)',
  'renderer-coordination': 'Renderer — Coordination',
};

const TYPE_ORDER: DomainInfo['type'][] = [
  'main-entry',
  'main-coordination',
  'main-platform',
  'main-service',
  'main-wiring',
  'renderer-coordination',
  'renderer-entry',
  'renderer-modal',
];

// ── Output modes ───────────────────────────────────────────────────────────
const domains = discoverDomains();
const arg = process.argv[2];

if (arg === '--json') {
  const classification = classifyFiles(domains);
  const output = {
    domains: domains.map((d) => ({
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
  const d = domains.find((x) => x.domain === arg);
  if (!d) {
    console.error(`Unknown domain: ${arg}`);
    console.error(`Available: ${domains.map((x) => x.domain).join(', ')}`);
    process.exit(1);
  }
  console.log(`Domain: ${d.domain}`);
  console.log(`Type:   ${TYPE_LABELS[d.type]}`);
  console.log(`Entry:  ${d.entryFile}`);
  console.log(`Test:   ${d.testFile || '(none)'}`);
  console.log(`Files (${d.fileCount}):`);
  d.files.forEach((f) => {
    const abs = resolve(MAC_APP, f);
    const tag = isSharedFile(abs) ? ' [shared]' : '';
    console.log(`  ${f}${tag}`);
  });
  process.exit(0);
}

// Default: summary table
console.log(`Mac-App Domain Map (${domains.length} domains)\n`);

const grouped = new Map<DomainInfo['type'], DomainInfo[]>();
for (const d of domains) {
  if (!grouped.has(d.type)) grouped.set(d.type, []);
  grouped.get(d.type)!.push(d);
}

for (const t of TYPE_ORDER) {
  const typeDomains = grouped.get(t);
  if (!typeDomains || typeDomains.length === 0) continue;
  console.log(`── ${TYPE_LABELS[t]} ──`);
  for (const d of typeDomains) {
    const test = d.testFile ? 'has tests' : 'NO TESTS';
    console.log(`  ${d.domain.padEnd(40)} ${String(d.fileCount).padStart(3)} files  [${test}]`);
  }
  console.log();
}

console.log(`Use: npx tsx scripts/map-domains.ts <domain> for details`);
console.log(`Use: npx tsx scripts/map-domains.ts --json for machine-readable output`);
console.log(`Use: npx tsx scripts/map-domains.ts --classify for shared file analysis`);
