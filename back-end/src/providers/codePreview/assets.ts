/**
 * The `rose-preview` CLI ships as a real file in `src/assets/code-preview/`
 * (copied to `dist/assets/` by `npm run build`) and is installed into
 * dev-account code sessions at ~/.rose/bin/rose-preview.
 */
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

const CLI_ASSET = join('bin', 'rose-preview.cjs');
let cached: Buffer | null = null;

/** dist/assets/code-preview when compiled, src/assets/code-preview under tsx. */
export function codePreviewAssetsDir(): string {
  const candidates = [
    resolve(__dirname, '../../assets/code-preview'),
    resolve(__dirname, '../../../src/assets/code-preview'),
  ];
  const found = candidates.find((dir) => existsSync(join(dir, CLI_ASSET)));
  if (!found) throw new Error(`rose-preview assets not found (looked in ${candidates.join(', ')})`);
  return found;
}

export function codePreviewCliScript(): Buffer {
  cached ??= readFileSync(join(codePreviewAssetsDir(), CLI_ASSET));
  return cached;
}
