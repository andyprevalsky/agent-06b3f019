#!/usr/bin/env tsx
import { config } from 'dotenv';
import {
  auditArchiveBundle,
  listArchiveBundleIds,
  type ArchiveBundleAuditResult,
} from '../src/providers/traceArchiveAudit';

config();

interface Args {
  all: boolean;
  json: boolean;
  rootAgentIds: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { all: false, json: false, rootAgentIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all') {
      args.all = true;
    } else if (arg === '--json') {
      args.json = true;
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

function renderHuman(results: ArchiveBundleAuditResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    lines.push(
      `${result.ok ? 'PASS' : 'FAIL'} ${result.rootAgentId} objects=${result.objectCount} encrypted=${result.encryptedObjectCount} decrypted=${result.decryptedObjectCount}`
    );
    for (const missing of result.missing) lines.push(`  missing ${missing}`);
    for (const invalid of result.invalid) lines.push(`  invalid ${invalid.path}: ${invalid.error}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rootAgentIds = args.all ? await listArchiveBundleIds() : args.rootAgentIds;
  const results = await Promise.all(rootAgentIds.map((id) => auditArchiveBundle(id)));
  process.stdout.write(
    args.json ? `${JSON.stringify({ results }, null, 2)}\n` : `${renderHuman(results)}\n`
  );
  if (results.length === 0 || results.some((result) => !result.ok)) process.exit(1);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
