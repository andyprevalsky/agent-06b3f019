#!/usr/bin/env tsx

import { config } from 'dotenv';
import pLimit from 'p-limit';
import { listArchiveBundleIdsStrict } from '../src/providers/traceArchiveAudit';
import {
  inspectFinalizedManifest,
  reconcileFinalizedManifest,
  type ManifestReconciliationResult,
} from '../src/providers/traceArchiveManifest';

config();

interface Args {
  all: boolean;
  apply: boolean;
  concurrency: number;
  json: boolean;
  limit: number;
  rootAgentIds: string[];
}

interface BundleResult {
  rootAgentId: string;
  before: ManifestReconciliationResult['status'] | 'error';
  after: ManifestReconciliationResult['status'] | 'error';
  actualArtifactCount: number;
  missingFromEncrypted: number;
  missingFromPublic: number;
  error?: string;
}

function positiveInteger(raw: string | undefined, flag: string): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} requires a positive integer`);
  return value;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    all: false,
    apply: false,
    concurrency: 4,
    json: false,
    limit: 0,
    rootAgentIds: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all') args.all = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--concurrency') {
      args.concurrency = positiveInteger(argv[index + 1], arg);
      index += 1;
    } else if (arg === '--limit') {
      args.limit = positiveInteger(argv[index + 1], arg);
      index += 1;
    } else if (arg === '--root-agent-id') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--root-agent-id requires a value');
      }
      args.rootAgentIds.push(value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.all && args.rootAgentIds.length === 0) {
    throw new Error('provide --all or at least one --root-agent-id');
  }
  return args;
}

function increment(counts: Record<string, number>, status: string): void {
  counts[status] = (counts[status] ?? 0) + 1;
}

async function processBundle(rootAgentId: string, apply: boolean): Promise<BundleResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const before = await inspectFinalizedManifest(rootAgentId);
      const after =
        apply && before.status === 'stale' ? await reconcileFinalizedManifest(rootAgentId) : before;
      return {
        rootAgentId,
        before: before.status,
        after: after.status,
        actualArtifactCount: after.actualArtifactCount,
        missingFromEncrypted: before.missingFromEncrypted.length,
        missingFromPublic: before.missingFromPublic.length,
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 250 * attempt * attempt));
    }
  }
  return {
    rootAgentId,
    before: 'error',
    after: 'error',
    actualArtifactCount: 0,
    missingFromEncrypted: 0,
    missingFromPublic: 0,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const listed = args.all ? await listArchiveBundleIdsStrict() : args.rootAgentIds;
  const rootAgentIds = args.limit > 0 ? listed.slice(0, args.limit) : listed;
  const limit = pLimit(args.concurrency);
  const started = Date.now();
  let completed = 0;
  const results = await Promise.all(
    rootAgentIds.map((rootAgentId) =>
      limit(async () => {
        const result = await processBundle(rootAgentId, args.apply);
        completed += 1;
        if (!args.json && (completed % 250 === 0 || completed === rootAgentIds.length)) {
          const elapsedSeconds = Math.max(0.001, (Date.now() - started) / 1_000);
          const rate = completed / elapsedSeconds;
          const eta = rate > 0 ? Math.round((rootAgentIds.length - completed) / rate) : 0;
          process.stdout.write(
            `[trace-manifest-backfill] ${completed}/${rootAgentIds.length} ${rate.toFixed(1)}/s eta=${eta}s\n`
          );
        }
        return result;
      })
    )
  );

  const before: Record<string, number> = {};
  const after: Record<string, number> = {};
  for (const result of results) {
    increment(before, result.before);
    increment(after, result.after);
  }
  const summary = {
    mode: args.apply ? 'apply' : 'dry-run',
    bundlesListed: listed.length,
    bundlesProcessed: results.length,
    before,
    after,
    repaired: results.filter((result) => result.after === 'updated').length,
    errors: results.filter((result) => result.error !== undefined).length,
    missingArtifactRefsBefore: {
      encrypted: results.reduce((sum, result) => sum + result.missingFromEncrypted, 0),
      public: results.reduce((sum, result) => sum + result.missingFromPublic, 0),
    },
    largestStaleBundles: results
      .filter((result) => result.before === 'stale')
      .sort(
        (left, right) =>
          right.missingFromEncrypted +
          right.missingFromPublic -
          (left.missingFromEncrypted + left.missingFromPublic)
      )
      .slice(0, 20)
      .map((result) => ({
        rootAgentId: result.rootAgentId,
        actualArtifactCount: result.actualArtifactCount,
        missingFromEncrypted: result.missingFromEncrypted,
        missingFromPublic: result.missingFromPublic,
      })),
    errorRootAgentIds: results
      .filter((result) => result.error !== undefined)
      .map((result) => result.rootAgentId),
    elapsedSeconds: Math.round((Date.now() - started) / 100) / 10,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  for (const result of results.filter((item) => item.error !== undefined).slice(0, 20)) {
    process.stderr.write(`${result.rootAgentId}: ${result.error}\n`);
  }
  if (summary.errors > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
