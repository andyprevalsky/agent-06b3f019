#!/usr/bin/env tsx
import { config } from 'dotenv';
import {
  curateTraceArchives,
  type ArchiveGoldClassification,
} from '../src/providers/traceArchiveCuration';
import { listArchiveBundleIds } from '../src/providers/traceArchiveAudit';

config();

interface Args {
  all: boolean;
  deleteRejected: boolean;
  json: boolean;
  rootAgentIds: string[];
  concurrency?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { all: false, deleteRejected: false, json: false, rootAgentIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all') {
      args.all = true;
    } else if (arg === '--delete') {
      args.deleteRejected = true;
    } else if (arg === '--dry-run') {
      args.deleteRejected = false;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--concurrency') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error('--concurrency requires a positive integer');
      }
      args.concurrency = Math.floor(value);
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

function renderClassification(classification: ArchiveGoldClassification): string {
  const decision = classification.gold ? 'KEEP' : 'REJECT';
  const reasons = classification.reasons.length > 0 ? classification.reasons.join(',') : 'gold';
  return [
    decision,
    classification.rootAgentId,
    `objects=${classification.objectCount}`,
    `replayable=${classification.replayableArtifactCount}`,
    `providers=${classification.providerArtifactCount}`,
    `media=${classification.mediaArtifactCount}`,
    `llm=${classification.llmTraceCount}`,
    `status=${classification.rootStatus ?? 'unknown'}`,
    `task=${classification.benchmarkTaskName ?? 'none'}`,
    `wm=${classification.worldModelMode ?? 'real'}`,
    `reason=${reasons}`,
  ].join(' ');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rootAgentIds = args.all ? await listArchiveBundleIds() : args.rootAgentIds;
  const results = await curateTraceArchives({
    rootAgentIds,
    deleteRejected: args.deleteRejected,
    concurrency: args.concurrency,
  });
  const summary = {
    mode: args.deleteRejected ? 'delete' : 'dry-run',
    total: results.length,
    kept: results.filter((result) => result.classification.gold).length,
    rejected: results.filter((result) => !result.classification.gold).length,
    deleted: results.filter((result) => result.deleted).length,
    deletedObjectCount: results.reduce((sum, result) => sum + result.deletedObjectCount, 0),
    results,
  };
  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `trace archive curation mode=${summary.mode} total=${summary.total} kept=${summary.kept} rejected=${summary.rejected} deleted=${summary.deleted} deleted_objects=${summary.deletedObjectCount}`,
      ...results.map((result) => {
        const suffix = result.deleted ? ` deleted_objects=${result.deletedObjectCount}` : '';
        return `${renderClassification(result.classification)}${suffix}`;
      }),
      '',
    ].join('\n')
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
