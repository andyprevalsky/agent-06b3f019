#!/usr/bin/env tsx
import { config } from 'dotenv';
import { migrateLegacyTraces } from '../src/providers/traceArchiveMigration';

config();

interface Args {
  sourceRoot?: string;
  runsDir?: string;
  llmDumpsDir?: string;
  includeLlmOnly: boolean;
  concurrency?: number;
  force: boolean;
  dryRun: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    includeLlmOnly: true,
    force: false,
    dryRun: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source-root') {
      args.sourceRoot = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--runs-dir') {
      args.runsDir = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--llm-dumps-dir') {
      args.llmDumpsDir = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--concurrency') {
      const value = Number(requireValue(argv, index, arg));
      if (!Number.isInteger(value) || value < 1) throw new Error('--concurrency must be a positive integer');
      args.concurrency = value;
      index += 1;
    } else if (arg === '--no-llm-only') {
      args.includeLlmOnly = false;
    } else if (arg === '--force') {
      args.force = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--json') {
      args.json = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function requireValue(argv: string[], index: number, arg: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
  return value;
}

function renderHuman(summary: Awaited<ReturnType<typeof migrateLegacyTraces>>): string {
  const lines = [
    `legacy trace migration: migrated=${summary.migrated} skipped=${summary.skipped} failed=${summary.failed}`,
  ];
  for (const result of summary.results) {
    const state = result.migrated ? 'MIGRATED' : result.skipped ? 'SKIPPED' : 'FAILED';
    lines.push(
      `${state} ${result.rootAgentId} source=${result.sourceKind} agents=${result.agentIds.length} llm=${result.llmDumpCount} artifacts=${result.artifactCount}${
        result.reason ? ` reason=${result.reason}` : ''
      }`
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const summary = await migrateLegacyTraces(args);
  process.stdout.write(args.json ? `${JSON.stringify(summary, null, 2)}\n` : `${renderHuman(summary)}\n`);
  if (summary.failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
