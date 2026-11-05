import type { IncomingMessage } from 'node:http';
import assert from 'node:assert/strict';
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
  // Imported by vite.config.ts; without it the preview dev server cannot start.
  'vite-build-version.ts',
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
  // The app throws at import without VITE_SUPABASE_* (src/lib/supabase.ts), so
  // a checkout without the untracked front-end/.env rendered a blank preview.
  // Use the committed public example, never this host's private env file.
  copyFileSync(join(FRONT_END, '.env.example'), join(frontEnd, '.env'));
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

/** Exact publication contract, shared without changing the owning assertions. */
export function assertPublicationPolicy(text: string): void {
  assert.match(text, /Publishing a Rose change to the agent network uses the existing `\/deploy`/);
  assert.match(text, /open pull request is not yet publication/);
  assert.match(text, /Preserve its checks and approvals/);
}

/** Arm the native DOM mutation observer for the next exact marker. */
export async function armMarkerWatch(
  page: import('playwright').Page,
  marker: string
): Promise<void> {
  // String evaluates: tsx's keepNames transform would inject __name into closures.
  await page.evaluate(
    `(() => { const m = ${JSON.stringify(marker)}; window.__roseSeenAt = 0;` +
      ' const obs = new MutationObserver(() => { if (document.body.innerText.includes(m)) {' +
      ' window.__roseSeenAt = performance.timeOrigin + performance.now(); obs.disconnect(); } });' +
      ' obs.observe(document.body, { subtree: true, childList: true, characterData: true }); })()'
  );
}

export async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : null;
}
