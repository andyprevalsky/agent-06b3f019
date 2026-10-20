/**
 * Seed contents for a code agent's `~/rose_user_ui/` folder plus the `rose-ui`
 * tooling installed under `~/.rose/`. Everything lives as real files in
 * `src/assets/user-ui/` (copied to `dist/assets/` by `npm run build`):
 *
 *   assets/user-ui/
 *     bin/rose-ui.cjs                 → ~/.rose/bin/rose-ui (CLI)
 *     lib/rose-ui/preview-host.html   → ~/.rose/lib/rose-ui/preview-host.html
 *     seed/**                         → ~/rose_user_ui/** for users with no published UI
 *       README.md                     regenerated every session (prompt-scoped text)
 *       examples/<name>/              hyper-expressive reference implementations
 *
 * README text is user/agent-facing instructions (prompt-scoped, CLAUDE.md
 * rule 26): changes need fresh approval.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import type { UserUiBundleFile } from './manifest';

export const USER_UI_DIR_NAME = 'rose_user_ui';
export const USER_UI_CLI_NAME = 'rose-ui';
/** Bumped whenever the README or CLI contract changes. */
export const USER_UI_CLI_VERSION = '2';
export const USER_UI_CLI_BIN_DIR = '.rose/bin';
export const USER_UI_PREVIEW_HOST_PATH = '.rose/lib/rose-ui/preview-host.html';

/** Examples shipped in every seed (examples/<name>/index.html). */
export const USER_UI_SEED_EXAMPLES = [
  'inline-hello',
  'shader-background',
  'agent-dashboard',
  'particles-worker',
  'media-menu',
  'rose-os',
  'wasm-viz',
] as const;

const CLI_ASSET = join('bin', 'rose-ui.cjs');

/** dist/assets/user-ui when compiled, src/assets/user-ui under tsx. */
export function userUiAssetsDir(): string {
  const candidates = [
    resolve(__dirname, '../../assets/user-ui'),
    resolve(__dirname, '../../../src/assets/user-ui'),
  ];
  const found = candidates.find((dir) => existsSync(join(dir, CLI_ASSET)));
  if (!found) throw new Error(`rose_user_ui assets not found (looked in ${candidates.join(', ')})`);
  return found;
}

const cache = new Map<string, Buffer>();
function asset(rel: string): Buffer {
  let content = cache.get(rel);
  if (!content) {
    content = readFileSync(join(userUiAssetsDir(), rel));
    cache.set(rel, content);
  }
  return content;
}

/** The README written into every session's rose_user_ui/ folder. */
export function userUiReadme(): string {
  return asset(join('seed', 'README.md')).toString('utf8');
}

/** The `rose-ui` CLI (Node script; browser commands need playwright-core + Chromium). */
export function userUiCliScript(): string {
  return asset(CLI_ASSET).toString('utf8');
}

/** CLI + preview host, as files relative to the session HOME. */
export function userUiToolFiles(): UserUiBundleFile[] {
  return [
    { path: `${USER_UI_CLI_BIN_DIR}/${USER_UI_CLI_NAME}`, content: asset(CLI_ASSET) },
    {
      path: USER_UI_PREVIEW_HOST_PATH,
      content: asset(join('lib', 'rose-ui', 'preview-host.html')),
    },
  ];
}

function walk(root: string, rel: string, out: UserUiBundleFile[]): void {
  const entries = readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, path, out);
    else if (entry.isFile()) out.push({ path, content: asset(join('seed', path)) });
  }
}

/** The starting bundle for a user with no published version. */
export function userUiSeedFiles(): UserUiBundleFile[] {
  const files: UserUiBundleFile[] = [];
  walk(join(userUiAssetsDir(), 'seed'), '', files);
  return files;
}
