/**
 * Fixtures for code-preview.blackbox.ts: a code-session HOME whose
 * `workspace/front-end` is a private copy of this checkout's Rose front-end
 * (sources copied so the test may edit them; dependencies and the 200 MB
 * `public/` linked), plus a real headless Chromium watching the preview DOM.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The checkout this test runs from (`back-end/..`). */
export const REPO_ROOT = resolve(process.cwd(), '..');
const FRONT_END = join(REPO_ROOT, 'front-end');

/** Sources the dev server reads; everything the edit can touch is a copy. */
const COPIED = [
  'src',
  'index.html',
  'vite.config.ts',
  'package.json',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'postcss.config.js',
  'tailwind.config.ts',
  'components.json',
];

/** Component the HMR case edits (its h1 renders on the signed-out /privacy route). */
export const HMR_EDIT_FILE = 'src/features/privacy/components/Privacy.tsx';
export const HMR_EDIT_ROUTE = '/privacy';
export const HMR_EDIT_TEXT = 'Privacy Policy';

/**
 * `<home>/workspace/front-end` = the Rose front-end. node_modules entries are
 * linked one by one (never the shared `.vite` cache) and the workspace-root
 * node_modules resolves hoisted packages, as an npm-workspaces checkout does.
 */
export function makeRoseFrontEndHome(home: string): string {
  const frontEnd = join(home, 'workspace', 'front-end');
  mkdirSync(join(frontEnd, 'node_modules'), { recursive: true });
  for (const entry of COPIED) {
    const source = join(FRONT_END, entry);
    if (existsSync(source)) cpSync(source, join(frontEnd, entry), { recursive: true });
  }
  if (existsSync(join(FRONT_END, '.env'))) {
    copyFileSync(join(FRONT_END, '.env'), join(frontEnd, '.env'));
  }
  symlinkSync(join(FRONT_END, 'public'), join(frontEnd, 'public'));
  const localModules = join(FRONT_END, 'node_modules');
  if (existsSync(localModules)) {
    for (const name of readdirSync(localModules)) {
      if (name.startsWith('.vite')) continue;
      symlinkSync(join(localModules, name), join(frontEnd, 'node_modules', name));
    }
  }
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(home, 'workspace', 'node_modules'));
  return frontEnd;
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? NaN;
}
