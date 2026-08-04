/**
 * Backfill platform GMV from R2 encrypted end-fixture snapshots.
 *
 * Live Postgres often drops completed agents; paid beanie/Amazon orders still
 * live in encrypted db/end.fixture snapshots. This walks those fixtures and
 * writes CLEARED PurchaseSpend rows via recordStructuredGmv (fingerprint +
 * AgentCard dedupe).
 *
 * Prerequisites: R2 + TRACE_ARCHIVE_* env (e.g. source /tmp/r2-env.sh).
 * Prefer listing end-fixture ids first:
 *   npx tsx scripts/list-r2-end-fixtures.ts
 *
 * Usage:
 *   npx tsx scripts/backfill-structured-gmv-from-r2.ts --dry-run
 *   npx tsx scripts/backfill-structured-gmv-from-r2.ts --apply
 *   npx tsx scripts/backfill-structured-gmv-from-r2.ts --apply --concurrency 20
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';

import { extractStructuredGmv } from '../src/domains/purchases/structuredGmvExtract';
import { recordStructuredGmv } from '../src/domains/purchases/structuredGmv';
import {
  decryptAndValidateArtifact,
  readArchivedArtifact,
} from '../src/providers/traceArchive';

function parseArgs(argv: string[]): {
  apply: boolean;
  concurrency: number;
  idsPath: string;
} {
  const apply = argv.includes('--apply');
  if (!apply && !argv.includes('--dry-run')) {
    console.error('Pass --dry-run or --apply');
    process.exit(2);
  }
  const concurrencyIdx = argv.indexOf('--concurrency');
  const idsIdx = argv.indexOf('--ids');
  const concurrencyRaw = concurrencyIdx >= 0 ? argv[concurrencyIdx + 1] : undefined;
  return {
    apply,
    concurrency:
      concurrencyRaw !== undefined && /^\d+$/.test(concurrencyRaw)
        ? Number.parseInt(concurrencyRaw, 10)
        : 20,
    idsPath:
      idsIdx >= 0 ? (argv[idsIdx + 1] ?? '/tmp/r2-end-fixture-ids.json') : '/tmp/r2-end-fixture-ids.json',
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function structuredFromMetadata(metadata: unknown): unknown {
  const record = asRecord(metadata);
  if (record === null) return null;
  const structured = record.structured_response ?? record.structuredResponse;
  return structured === undefined ? null : structured;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

type Candidate = {
  rootAgentId: string;
  userId: string;
  agentId: string;
  structured: unknown;
  source: string;
  occurredAt: Date;
  goal: string;
};

async function collectCandidates(rootAgentId: string): Promise<Candidate[]> {
  const stored = await readArchivedArtifact({
    rootAgentId,
    objectPath: 'db/end.fixture.json.gz.enc',
  });
  if (stored === null) return [];
  const fixture = JSON.parse(decryptAndValidateArtifact(stored).toString('utf8')) as Record<
    string,
    unknown
  >;
  const rows = asRecord(fixture.rows) ?? fixture;
  const agents = Array.isArray(rows.Agent) ? (rows.Agent as unknown[]) : [];
  const messages = Array.isArray(rows.Message) ? (rows.Message as unknown[]) : [];

  let rootGoal = '';
  const out: Candidate[] = [];
  for (const agent of agents) {
    const record = asRecord(agent);
    if (record === null) continue;
    if (record.parentAgentId == null && typeof record.goal === 'string') rootGoal = record.goal;
    if (record.structuredResponse === undefined || record.structuredResponse === null) continue;
    if (extractStructuredGmv(record.structuredResponse) === null) continue;
    if (typeof record.userId !== 'string' || typeof record.id !== 'string') continue;
    const occurredAt =
      typeof record.updatedAt === 'string'
        ? new Date(record.updatedAt)
        : typeof record.createdAt === 'string'
          ? new Date(record.createdAt)
          : new Date();
    out.push({
      rootAgentId,
      userId: record.userId,
      agentId: record.id,
      structured: record.structuredResponse,
      source: 'backfill.r2.agent.structuredResponse',
      occurredAt,
      goal: rootGoal,
    });
  }
  for (const message of messages) {
    const record = asRecord(message);
    if (record === null) continue;
    const metadata = asRecord(record.metadata);
    if (metadata === null || metadata.toolStatus !== 'FINISHED') continue;
    const structured = structuredFromMetadata(metadata);
    if (extractStructuredGmv(structured) === null) continue;
    const agentId = typeof record.agentId === 'string' ? record.agentId : null;
    if (agentId === null) continue;
    const agent = agents
      .map((row) => asRecord(row))
      .find((row) => row !== null && row.id === agentId);
    const userId = typeof agent?.userId === 'string' ? agent.userId : null;
    if (userId === null) continue;
    const occurredAt =
      typeof record.createdAt === 'string' ? new Date(record.createdAt) : new Date();
    out.push({
      rootAgentId,
      userId,
      agentId,
      structured,
      source: 'backfill.r2.message.structured_response',
      occurredAt,
      goal: rootGoal,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const { apply, concurrency, idsPath } = parseArgs(process.argv.slice(2));
  process.env.TRACE_ARCHIVE_BACKEND = process.env.TRACE_ARCHIVE_BACKEND || 'r2';
  process.env.TRACE_ARCHIVE_ENABLED = process.env.TRACE_ARCHIVE_ENABLED || 'true';

  const ids = JSON.parse(readFileSync(idsPath, 'utf8')) as string[];
  console.error(`R2 GMV backfill mode=${apply ? 'apply' : 'dry-run'} fixtures=${ids.length}`);

  const all: Candidate[] = [];
  let done = 0;
  await mapPool(ids, concurrency, async (rootAgentId) => {
    const candidates = await collectCandidates(rootAgentId);
    all.push(...candidates);
    done += 1;
    if (done % 100 === 0 || done === ids.length) {
      console.error(`scan ${done}/${ids.length} candidates=${all.length}`);
    }
    return candidates;
  });

  const isSyntheticTestPayment = (goal: string): boolean =>
    /test_payment|trycloudflare\.com|ngrok\.app|agentcard-live-lifecycle/i.test(goal);

  // Dedupe candidates by confirmation fingerprint before write.
  const unique = new Map<string, Candidate>();
  const samples: Array<Record<string, unknown>> = [];
  let skippedSynthetic = 0;
  for (const candidate of all) {
    const capture = extractStructuredGmv(candidate.structured);
    if (capture === null) continue;
    if (isSyntheticTestPayment(candidate.goal)) {
      skippedSynthetic += 1;
      continue;
    }
    const key = `${candidate.userId}:${capture.confirmationId.trim().toLowerCase()}`;
    if (!unique.has(key)) {
      unique.set(key, candidate);
      if (samples.length < 40) {
        samples.push({
          rootAgentId: candidate.rootAgentId,
          agentId: candidate.agentId,
          totalCents: capture.totalCents,
          confirmationId: capture.confirmationId,
          goal: candidate.goal.slice(0, 120),
          occurredAt: candidate.occurredAt.toISOString(),
        });
      }
    }
  }

  let created = 0;
  let recorded = 0;
  let skipped = 0;
  if (apply) {
    for (const candidate of unique.values()) {
      const result = await recordStructuredGmv({
        userId: candidate.userId,
        agentId: candidate.agentId,
        structured: candidate.structured,
        source: candidate.source,
        occurredAt: candidate.occurredAt,
      });
      if (result.status === 'skipped') skipped += 1;
      else {
        recorded += 1;
        if (result.created) created += 1;
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        fixtures: ids.length,
        candidatesRaw: all.length,
        skippedSyntheticTestPayment: skippedSynthetic,
        uniqueConfirmations: unique.size,
        created,
        recorded,
        skipped,
        samples,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
