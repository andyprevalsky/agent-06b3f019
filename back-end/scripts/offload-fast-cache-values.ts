/**
 * Move existing large Fast Mode cache values (browser_http ≥ 64 KB) out of
 * FastModeCacheEntry into Storage, leaving a verified pointer in each row.
 * Readers rehydrate transparently, so nothing a demo or agent sees changes.
 *
 * Primary-key-ordered and resumable with `--after <key>`. `--dry-run` counts
 * the same rows and bytes read-only. `--receipt <file>` appends one JSON line
 * per batch listing every moved key and the sha256-verified object holding it.
 * `--max-rows N` stops after N scanned rows (staged rollout).
 *
 * Usage (from back-end/):
 *   npx tsx scripts/offload-fast-cache-values.ts [--dry-run] [--batch-size 1..2000]
 *     [--after <key>] [--receipt <file>] [--max-rows N] [--pause-ms 0..10000]
 */
import 'dotenv/config';
import { appendFileSync } from 'node:fs';
import { offloadFastCacheBatch } from '../src/providers/demoCacheStore';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const usage =
    'Usage: offload-fast-cache-values.ts [--dry-run] [--batch-size 1..2000] [--after <key>] [--receipt <file>] [--max-rows N] [--pause-ms 0..10000]';
  const valueFlags = ['--batch-size', '--after', '--receipt', '--max-rows', '--pause-ms'];
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    const operand = args[index + 1];
    if (operand === undefined || operand.startsWith('--')) throw new Error(usage);
    return operand;
  };
  const operands = new Set(
    valueFlags
      .map((flag) => args.indexOf(flag))
      .filter((index) => index >= 0)
      .map((index) => index + 1)
  );
  if (
    args.some(
      (arg, index) => !operands.has(index) && !valueFlags.includes(arg) && arg !== '--dry-run'
    )
  )
    throw new Error(usage);
  const batchSize = Number(value('--batch-size') ?? 500);
  const maxRows = Number(value('--max-rows') ?? Number.MAX_SAFE_INTEGER);
  const pauseMs = Number(value('--pause-ms') ?? 0);
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 2_000 ||
    !Number.isInteger(maxRows) ||
    maxRows < 1 ||
    !Number.isInteger(pauseMs) ||
    pauseMs < 0 ||
    pauseMs > 10_000
  )
    throw new Error(usage);
  const dryRun = args.includes('--dry-run');
  const receipt = value('--receipt');
  let afterKey: string | null = value('--after') ?? null;
  const totals = { scanned: 0, offloaded: 0, bytes: 0 };
  for (let batches = 1; totals.scanned < maxRows; batches += 1) {
    const from = afterKey;
    const batch = await offloadFastCacheBatch(
      afterKey,
      Math.min(batchSize, maxRows - totals.scanned),
      { dryRun }
    );
    if (batch.scanned === 0) break;
    afterKey = batch.lastKey;
    totals.scanned += batch.scanned;
    totals.offloaded += batch.offloaded;
    totals.bytes += batch.bytes;
    if (receipt) {
      appendFileSync(
        receipt,
        `${JSON.stringify({ at: new Date().toISOString(), dryRun, after: from, through: batch.lastKey, scanned: batch.scanned, offloaded: batch.offloaded, bytes: batch.bytes, rows: batch.offloadedRows })}\n`,
        { mode: 0o600 }
      );
    }
    if (batches % 20 === 0) {
      process.stderr.write(
        `Scanned ${totals.scanned} rows (${totals.offloaded} offloaded, ${(totals.bytes / 1e9).toFixed(2)} GB${dryRun ? ', dry run' : ''}); cursor ${afterKey}\n`
      );
    }
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  process.stdout.write(
    `${JSON.stringify({ mode: 'fast-cache-offload', dryRun, ...totals, cursor: afterKey })}\n`
  );
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
