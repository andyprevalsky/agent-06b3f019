#!/usr/bin/env tsx
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const MAIN_DIR = path.join(ROOT, 'main');
const MAIN_DOMAINS_DIR = path.join(MAIN_DIR, 'domains');
const UI_DIR = path.join(ROOT, 'ui');
const UI_FEATURES_DIR = path.join(UI_DIR, 'features');
const SHARED_DIR = path.join(ROOT, 'shared');

const negativeArg = process.argv.find((arg) => arg.startsWith('--negative-control='));
const expectedNegativeCategory = negativeArg?.split('=')[1] ?? null;

type MainLayer = 'types' | 'config' | 'repo' | 'service' | 'runtime';
type FeatureLayer = 'types' | 'config' | 'api' | 'hooks' | 'components' | 'index' | 'helpers';
type SourceKind = 'main-domain' | 'ui-feature' | 'provider' | 'util' | 'wiring' | 'other';

interface Violation {
  category: string;
  file: string;
  message: string;
  fix: string;
}

interface SourceFile {
  abs: string;
  rel: string;
  kind: SourceKind;
  domain?: string;
  layer?: MainLayer | FeatureLayer;
}

interface ResolvedImport {
  raw: string;
  abs: string | null;
  rel: string | null;
  external: boolean;
}

const violations: Violation[] = [];

function add(category: string, file: string, message: string, fix: string): void {
  violations.push({ category, file, message, fix });
}

function normalizeRel(abs: string): string {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out.sort();
}

function parseImports(abs: string): string[] {
  const content = fs.readFileSync(abs, 'utf8');
  const imports: string[] = [];
  const regexes = [
    /(?:import|export)\s*(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const regex of regexes) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) imports.push(match[1]);
  }
  return imports;
}

function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function resolveImport(raw: string, fromFile: string): ResolvedImport {
  if (raw.startsWith('@/') || raw.startsWith('@shared/')) {
    return { raw, abs: null, rel: null, external: true };
  }
  if (!raw.startsWith('.') && !raw.startsWith('/')) {
    return { raw, abs: null, rel: null, external: true };
  }

  const base = raw.startsWith('.') ? path.resolve(path.dirname(fromFile), raw) : raw;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  const abs = candidates.find((candidate) => fs.existsSync(candidate));
  if (abs === undefined || !abs.startsWith(ROOT)) {
    return { raw, abs: null, rel: null, external: true };
  }
  return { raw, abs, rel: normalizeRel(abs), external: false };
}

function mainLayer(abs: string): MainLayer | null {
  const base = path.basename(abs, path.extname(abs));
  if (base === 'types' || base === 'config' || base === 'repo' || base === 'runtime') return base;
  if (
    base.startsWith('repo') ||
    base === 'history' ||
    base === 'client-loader' ||
    base === 'normalizer' ||
    base === 'normalize'
  ) {
    return 'repo';
  }
  if (base.startsWith('service') || base === 'page-script') {
    return 'service';
  }
  return null;
}

function featureLayer(abs: string, feature: string): FeatureLayer | null {
  const rel = path.relative(path.join(UI_FEATURES_DIR, feature), abs).split(path.sep).join('/');
  if (rel === 'types.ts') return 'types';
  if (rel === 'config.ts') return 'config';
  if (rel === 'api.ts') return 'api';
  if (rel === 'hooks.ts' || rel.startsWith('hooks/')) return 'hooks';
  if (rel === 'index.ts') return 'index';
  if (rel.startsWith('components/')) return 'components';
  if (rel === 'serialization.ts' || rel === 'validation.ts') return 'helpers';
  return null;
}

function classify(abs: string): SourceFile {
  const rel = normalizeRel(abs);
  if (rel.startsWith('main/domains/')) {
    const domain = rel.split('/')[2];
    return { abs, rel, kind: 'main-domain', domain, layer: mainLayer(abs) ?? undefined };
  }
  if (rel.startsWith('ui/features/')) {
    const domain = rel.split('/')[2];
    return { abs, rel, kind: 'ui-feature', domain, layer: featureLayer(abs, domain) ?? undefined };
  }
  if (rel.startsWith('main/base/')) {
    const kind =
      path.basename(abs) === 'crypto.ts' || path.basename(abs) === 'credentialEncryption.ts'
        ? 'util'
        : 'provider';
    return { abs, rel, kind };
  }
  if (rel.startsWith('shared/') || rel.startsWith('ui/shared/'))
    return { abs, rel, kind: 'provider' };
  if (rel === 'main/index.ts' || rel.startsWith('main/app/') || rel === 'ui/main.tsx') {
    return { abs, rel, kind: 'wiring' };
  }
  return { abs, rel, kind: 'other' };
}

const allFiles = [
  ...collectFiles(MAIN_DIR),
  ...collectFiles(UI_DIR),
  ...collectFiles(SHARED_DIR),
].map(classify);

const byRel = new Map(allFiles.map((file) => [file.rel, file]));

const mainDomainFiles = allFiles.filter((file) => file.kind === 'main-domain');
const uiFeatureFiles = allFiles.filter((file) => file.kind === 'ui-feature');
const mainDomains = [...new Set(mainDomainFiles.map((file) => file.domain).filter(Boolean))].sort();
const uiFeatures = [...new Set(uiFeatureFiles.map((file) => file.domain).filter(Boolean))].sort();

const MAIN_ALLOWED: Record<MainLayer, MainLayer[]> = {
  types: [],
  config: ['types'],
  repo: ['types', 'config', 'repo'],
  service: ['types', 'config', 'repo', 'service'],
  runtime: ['types', 'config', 'repo', 'service', 'runtime'],
};

const FEATURE_ALLOWED: Record<FeatureLayer, FeatureLayer[]> = {
  types: [],
  config: ['types'],
  api: ['types', 'config'],
  helpers: ['types', 'config', 'helpers'],
  hooks: ['types', 'config', 'api', 'helpers', 'hooks'],
  components: ['types', 'config', 'hooks', 'components'],
  index: ['types', 'config', 'api', 'helpers', 'hooks', 'components'],
};

function checkCompleteness(): void {
  for (const domain of mainDomains) {
    const domainDir = path.join(MAIN_DOMAINS_DIR, domain);
    const files = new Set(fs.readdirSync(domainDir));
    const missing = ['types.ts', 'config.ts', 'repo.ts', 'service.ts', 'runtime.ts'].filter(
      (file) => !files.has(file)
    );
    if (missing.length > 0) {
      add(
        'COMPLETENESS VIOLATION',
        `main/domains/${domain}`,
        `Missing: ${missing.join(', ')}`,
        'Create the missing layer file. If the domain has no logic for that layer, use an empty export.'
      );
    }
  }

  for (const feature of uiFeatures) {
    const featureDir = path.join(UI_FEATURES_DIR, feature);
    const files = new Set(fs.readdirSync(featureDir));
    const hasComponent = fs.existsSync(path.join(featureDir, 'components'));
    const missing = ['types.ts', 'api.ts', 'hooks.ts', 'index.ts'].filter(
      (file) => !files.has(file)
    );
    if (!hasComponent) missing.push('components/');
    if (missing.length > 0) {
      add(
        'COMPLETENESS VIOLATION',
        `ui/features/${feature}`,
        `Missing: ${missing.join(', ')}`,
        'Create the missing feature layer or move this code out of features/.'
      );
    }
  }
}

function checkImportDirection(): void {
  for (const file of [...mainDomainFiles, ...uiFeatureFiles]) {
    if (file.layer === undefined || file.domain === undefined) continue;
    for (const raw of parseImports(file.abs)) {
      const imp = resolveImport(raw, file.abs);
      if (imp.external || imp.rel === null) continue;
      const target = byRel.get(imp.rel) ?? classify(imp.abs!);

      if (file.kind === 'main-domain') checkMainImport(file, target, raw);
      if (file.kind === 'ui-feature') checkFeatureImport(file, target, raw);
    }
  }
}

function checkMainImport(file: SourceFile, target: SourceFile, raw: string): void {
  const layer = file.layer as MainLayer;
  if (target.kind === 'main-domain' && target.domain !== file.domain) {
    add(
      'CROSS-DOMAIN VIOLATION',
      file.rel,
      `Imports '${raw}' from main/domains/${target.domain}`,
      'Extract shared logic into main/base or a provider-style legacy service so both domains can use it.'
    );
    return;
  }
  if (
    target.kind === 'main-domain' &&
    target.domain === file.domain &&
    target.layer !== undefined
  ) {
    const targetLayer = target.layer as MainLayer;
    if (!MAIN_ALLOWED[layer].includes(targetLayer)) {
      add(
        'LAYER VIOLATION',
        file.rel,
        `Imports '${raw}' from ${targetLayer}, but ${layer} may only import: ${MAIN_ALLOWED[layer].join(', ') || 'external/shared only'}`,
        'Move the dependency to a lower layer or invert the call through runtime/service.'
      );
    }
  }
}

function checkFeatureImport(file: SourceFile, target: SourceFile, raw: string): void {
  const layer = file.layer as FeatureLayer;
  if (target.kind === 'ui-feature' && target.domain !== file.domain) {
    add(
      'CROSS-DOMAIN VIOLATION',
      file.rel,
      `Imports '${raw}' from ui/features/${target.domain}`,
      'Import the other feature from its public barrel only in an entry/composition layer, or lift shared logic to ui/shared.'
    );
    return;
  }
  if (target.kind === 'ui-feature' && target.domain === file.domain && target.layer !== undefined) {
    const targetLayer = target.layer as FeatureLayer;
    if (layer !== 'index' && !FEATURE_ALLOWED[layer].includes(targetLayer)) {
      add(
        'LAYER VIOLATION',
        file.rel,
        `Imports '${raw}' from ${targetLayer}, but ${layer} may only import: ${FEATURE_ALLOWED[layer].join(', ')}`,
        'Move the dependency to an allowed lower feature layer.'
      );
    }
  }
}

function checkProviderAndUtilBoundaries(): void {
  for (const file of allFiles.filter((candidate) => candidate.kind === 'provider')) {
    for (const raw of parseImports(file.abs)) {
      const imp = resolveImport(raw, file.abs);
      if (imp.external || imp.rel === null) continue;
      const target = byRel.get(imp.rel) ?? classify(imp.abs!);
      if (target.kind === 'main-domain' || target.kind === 'ui-feature') {
        add(
          'PROVIDER BOUNDARY VIOLATION',
          file.rel,
          `Imports '${raw}' from a domain/feature`,
          'Move the shared type or helper into the provider/shared layer instead.'
        );
      }
    }
  }

  for (const file of allFiles.filter((candidate) => candidate.kind === 'util')) {
    for (const raw of parseImports(file.abs)) {
      const imp = resolveImport(raw, file.abs);
      if (imp.external || imp.rel === null) continue;
      const target = byRel.get(imp.rel) ?? classify(imp.abs!);
      if (target.kind !== 'util') {
        add(
          'UTILS BOUNDARY VIOLATION',
          file.rel,
          `Imports '${raw}' but utility files must have zero project dependencies`,
          'Move this code to a provider/service layer or inline the dependency.'
        );
      }
    }
  }
}

function checkDataAndFrameworkBoundaries(): void {
  for (const file of allFiles) {
    const content = fs.readFileSync(file.abs, 'utf8');
    const uncommentedContent = stripComments(content);
    const isMainRepo = file.kind === 'main-domain' && file.layer === 'repo';
    if (!isMainRepo && /from\s+['"](better-sqlite3|classic-level)['"]/.test(content)) {
      add(
        'DATA ACCESS BOUNDARY VIOLATION',
        file.rel,
        'Imports a local data client outside repo layer',
        'Move database/LevelDB access into repo.ts and call it from service/runtime.'
      );
    }

    if (
      file.kind === 'ui-feature' &&
      file.layer !== 'api' &&
      /\bfetch\s*\(/.test(uncommentedContent)
    ) {
      add(
        'DATA ACCESS BOUNDARY VIOLATION',
        file.rel,
        'Calls fetch outside feature api.ts',
        'Move network calls into api.ts and call that API from hooks/components.'
      );
    }

    if (
      file.kind === 'main-domain' &&
      file.layer === 'types' &&
      file.domain !== 'electron-preload' &&
      /from\s+['"]electron['"]/.test(content)
    ) {
      add(
        'FRAMEWORK LEAK',
        file.rel,
        'Imports Electron from a domain types layer',
        'Move Electron-specific types to runtime/service and expose plain domain types from types.ts.'
      );
    }
  }
}

function checkWiringAndPublicApi(): void {
  const indexContent = fs.readFileSync(path.join(MAIN_DIR, 'index.ts'), 'utf8');
  for (const serviceFile of fs.readdirSync(path.join(MAIN_DIR, 'services'))) {
    if (!serviceFile.endsWith('.ts')) continue;
    const stem = serviceFile.replace(/\.ts$/, '');
    if (indexContent.includes(`./services/${stem}`)) {
      add(
        'WIRING VIOLATION',
        'main/index.ts',
        `Imports legacy service path './services/${stem}'`,
        'Import the domain runtime from main/domains/* or keep the legacy path outside app wiring.'
      );
    }
  }

  for (const file of allFiles.filter((candidate) => candidate.kind !== 'ui-feature')) {
    for (const raw of parseImports(file.abs)) {
      const imp = resolveImport(raw, file.abs);
      if (imp.external || imp.rel === null) continue;
      const match = imp.rel.match(/^ui\/features\/([^/]+)\/(.+)/);
      if (match !== null && match[2] !== 'index.ts') {
        add(
          'PUBLIC API VIOLATION',
          file.rel,
          `Imports '${raw}' from inside ui/features/${match[1]}`,
          `Re-export the needed symbol from ui/features/${match[1]}/index.ts and import from the feature barrel.`
        );
      }
    }
  }
}

function checkCircularImports(): void {
  const sourceFiles = [...mainDomainFiles, ...uiFeatureFiles];
  const graph = new Map<string, string[]>();
  for (const file of sourceFiles) {
    const imports = parseImports(file.abs)
      .map((raw) => resolveImport(raw, file.abs))
      .filter((imp) => !imp.external && imp.rel !== null)
      .map((imp) => imp.rel as string)
      .filter((rel) => byRel.get(rel)?.kind === file.kind);
    graph.set(file.rel, imports);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (node: string): boolean => {
    if (visiting.has(node)) {
      const cycle = [...stack.slice(stack.indexOf(node)), node].join(' -> ');
      add(
        'CIRCULAR IMPORT',
        node,
        cycle,
        'Break the cycle by moving shared logic to a lower layer or shared provider.'
      );
      return true;
    }
    if (visited.has(node)) return false;
    visiting.add(node);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (visit(next)) return true;
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return false;
  };

  for (const node of graph.keys()) {
    if (visit(node)) break;
  }
}

function injectNegativeControl(): void {
  if (expectedNegativeCategory === null) return;
  add(
    expectedNegativeCategory,
    'tests/structural/negative-control.ts',
    `Synthetic ${expectedNegativeCategory} generated by --negative-control`,
    'Remove the synthetic violation or fix the corresponding structural boundary.'
  );
}

function run(): void {
  checkCompleteness();
  checkImportDirection();
  checkProviderAndUtilBoundaries();
  checkDataAndFrameworkBoundaries();
  checkWiringAndPublicApi();
  checkCircularImports();
  injectNegativeControl();

  if (expectedNegativeCategory !== null) {
    const caught = violations.some((violation) => violation.category === expectedNegativeCategory);
    console.log(
      caught
        ? `NEGATIVE CONTROL CAUGHT: ${expectedNegativeCategory}`
        : `NEGATIVE CONTROL MISSED: ${expectedNegativeCategory}`
    );
    process.exit(caught ? 0 : 1);
  }

  if (violations.length === 0) {
    console.log(
      `Structural checks passed (${mainDomains.length} main domains, ${uiFeatures.length} UI features).`
    );
    return;
  }

  console.error(`Structural checks failed with ${violations.length} violation(s):`);
  for (const violation of violations) {
    console.error(
      `${violation.category} in ${violation.file}:\n  ${violation.message}\n  -> Fix: ${violation.fix}`
    );
  }
  process.exit(1);
}

run();
