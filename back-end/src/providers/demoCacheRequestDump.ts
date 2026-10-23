import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { stripSecrets } from './fastCacheNormalizeCore';

const requestDumpCounters = new Map<string, number>();

export function maybeDumpFastCacheRequest(
  goalHash: string,
  key: string | null,
  body: unknown
): void {
  const dir = process.env.FAST_MODE_CODEX_REQUEST_DUMP_DIR;
  if (dir === undefined || dir === '' || key === null) return;

  const sequence = (requestDumpCounters.get(goalHash) ?? 0) + 1;
  requestDumpCounters.set(goalHash, sequence);
  mkdirSync(dir, { recursive: true });
  const safeKey = key.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 160);
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${goalHash}-${String(sequence).padStart(3, '0')}-${safeKey}.json`;
  writeFileSync(
    path.join(dir, filename),
    JSON.stringify({ goalHash, key, sequence, body: stripSecrets(body) }, null, 2)
  );
}
