/** Downloadable dependency-free setup client. No account data or credentials are embedded. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const FILES = [
  'rose-sync',
  'lib/rose-sync/cli.mjs',
  'lib/rose-sync/capture.mjs',
  'lib/rose-sync/onboarding.mjs',
];
export function projectSyncClientFiles() {
  const scripts = resolve(__dirname, '../../../../scripts');
  return FILES.map((path) => ({ path, content: readFileSync(resolve(scripts, path), 'utf8') }));
}
