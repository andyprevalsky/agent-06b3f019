#!/usr/bin/env tsx
/**
 * Every browser-provider-name dispatcher in back-end/src must handle `tilion`
 * (plan criterion A4, docs/plans/completed/tilion-browser-provider.md).
 *
 * A dispatcher is a source file that compares a provider value against two or
 * more provider names ('kernel' | 'steel' | 'browser-use'). Such a file without
 * a 'tilion' literal silently routes Tilion rows down another provider's path:
 * e.g. a superseded Tilion session released through Steel leaks a paid browser.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '../..');

/**
 * Reviewed files whose provider comparisons only special-case other providers
 * while Tilion takes a correct provider-generic path. Each needs a reason.
 */
const REVIEWED_GENERIC: ReadonlyMap<string, string> = new Map<string, string>([
  [
    'providers/browser/resumeRecovery.ts',
    'Native locator lookup for the resume-custody lifecycle, which resumeBrowserSession ' +
      'enters only for Kernel and Browser Use rows; Tilion resumes outside it and never ' +
      'reaches this inspector (an unknown provider returns null).',
  ],
]);

const COMPARISON =
  /[pP]rovider\)?\s*[!=]==\s*'(browser-use|kernel|steel)'|'(browser-use|kernel|steel)'\s*[!=]==\s*[\w.]*[pP]rovider\b/g;

export function dispatchedProviders(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(COMPARISON)) names.add(match[1] ?? match[2] ?? '');
  return names;
}

export function lacksTilionBranch(source: string): boolean {
  return dispatchedProviders(source).size >= 2 && !source.includes("'tilion'");
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'tests' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

function testDetectorRecognisesDispatchers(): void {
  const twoWay = `if (provider === 'kernel') a(); else if (provider === 'browser-use') b();`;
  assert(lacksTilionBranch(twoWay), 'a two-provider dispatcher without tilion must be flagged');
  assert(
    !lacksTilionBranch(`${twoWay} else if (provider === 'tilion') c();`),
    'a dispatcher with a tilion branch passes'
  );
  assert(
    !lacksTilionBranch(`if (session.provider === 'steel') steelOnly();`),
    'a single provider-specific check is not a dispatcher'
  );
  assert(
    lacksTilionBranch(
      `x = old.provider === 'kernel' ? 'kernel' : old.provider === 'steel' ? 'steel' : 'browser-use';`
    ),
    'a provider-name mapping ternary is a dispatcher'
  );
}

function testEveryDispatcherHandlesTilion(): void {
  const missing: string[] = [];
  const stale: string[] = [];
  for (const file of sourceFiles(srcDir)) {
    const relative = path.relative(srcDir, file).split(path.sep).join('/');
    const source = fs.readFileSync(file, 'utf8');
    if (REVIEWED_GENERIC.has(relative)) {
      // Re-review once the file branches on tilion itself.
      if (source.includes("'tilion'")) stale.push(relative);
      continue;
    }
    if (lacksTilionBranch(source)) missing.push(relative);
  }
  assert.deepStrictEqual(
    missing,
    [],
    `provider dispatchers without a 'tilion' branch: ${missing.join(', ')}`
  );
  assert.deepStrictEqual(
    stale,
    [],
    `remove from REVIEWED_GENERIC (they now branch on tilion): ${stale.join(', ')}`
  );
}

testDetectorRecognisesDispatchers();
testEveryDispatcherHandlesTilion();
console.log('PASS browser-provider tilion branch structural test (2 cases)');
