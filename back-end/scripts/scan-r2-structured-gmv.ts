/**
 * Scan R2 db/end.fixture.json.gz.enc objects for paid-order structured outputs.
 *
 * Usage:
 *   source /tmp/r2-env.sh && TRACE_ARCHIVE_BACKEND=r2 TRACE_ARCHIVE_ENABLED=true \
 *     npx tsx scripts/scan-r2-structured-gmv.ts [--concurrency 20] [--query beanie]
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';

import { extractStructuredGmv } from '../src/domains/purchases/structuredGmvExtract';
import {
  decryptAndValidateArtifact,
  readArchivedArtifact,
} from '../src/providers/traceArchive';

function parseArgs(argv: string[]): {
  concurrency: number;
  query: string | null;
  idsPath: string;
} {
  const concurrencyIdx = argv.indexOf('--concurrency');
  const queryIdx = argv.indexOf('--query');
  const idsIdx = argv.indexOf('--ids');
  const concurrencyRaw = concurrencyIdx >= 0 ? argv[concurrencyIdx + 1] : undefined;
  const concurrency =
    concurrencyRaw !== undefined && /^\d+$/.test(concurrencyRaw)
      ? Number.parseInt(concurrencyRaw, 10)
      : 25;
  return {
    concurrency,
    query: queryIdx >= 0 ? (argv[queryIdx + 1] ?? null) : null,
    idsPath: idsIdx >= 0 ? (argv[idsIdx + 1] ?? '/tmp/r2-end-fixture-ids.json') : '/tmp/r2-end-fixture-ids.json',
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
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

type Hit = {
  rootAgentId: string;
  source: string;
  agentId: string | null;
  goal: string;
  totalCents: number;
  confirmationId: string;
  merchant: string;
  amountKey: string;
  confirmationKey: string;
};

async function scanBundle(rootAgentId: string, query: string | null): Promise<{
  hits: Hit[];
  queryHit: boolean;
  goal: string;
  purchaseSpendCleared: Array<{ totalCents: number; provider: string; merchant: string }>;
  error: string | null;
}> {
  try {
    const stored = await readArchivedArtifact({
      rootAgentId,
      objectPath: 'db/end.fixture.json.gz.enc',
    });
    if (stored === null) {
      return { hits: [], queryHit: false, goal: '', purchaseSpendCleared: [], error: 'missing' };
    }
    const plaintext = decryptAndValidateArtifact(stored);
    const fixture = JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>;
    const rows = asRecord(fixture.rows) ?? fixture;
    const agents = Array.isArray((rows as Record<string, unknown>).Agent)
      ? ((rows as Record<string, unknown>).Agent as unknown[])
      : [];
    const messages = Array.isArray((rows as Record<string, unknown>).Message)
      ? ((rows as Record<string, unknown>).Message as unknown[])
      : [];
    const purchases = Array.isArray((rows as Record<string, unknown>).PurchaseSpend)
      ? ((rows as Record<string, unknown>).PurchaseSpend as unknown[])
      : [];

    let goal = '';
    for (const agent of agents) {
      const record = asRecord(agent);
      if (record === null) continue;
      if (record.parentAgentId == null && typeof record.goal === 'string') {
        goal = record.goal;
        break;
      }
    }

    const blob = JSON.stringify({ goal, agents, messages, purchases }).toLowerCase();
    const queryHit = query !== null && blob.includes(query.toLowerCase());

    const hits: Hit[] = [];
    for (const agent of agents) {
      const record = asRecord(agent);
      if (record === null) continue;
      const capture = extractStructuredGmv(record.structuredResponse);
      if (capture === null) continue;
      hits.push({
        rootAgentId,
        source: 'agent.structuredResponse',
        agentId: typeof record.id === 'string' ? record.id : null,
        goal: goal.slice(0, 160),
        totalCents: capture.totalCents,
        confirmationId: capture.confirmationId,
        merchant: capture.merchant,
        amountKey: capture.amountKey,
        confirmationKey: capture.confirmationKey,
      });
    }
    for (const message of messages) {
      const record = asRecord(message);
      if (record === null) continue;
      const metadata = asRecord(record.metadata);
      if (metadata === null || metadata.toolStatus !== 'FINISHED') continue;
      const capture = extractStructuredGmv(structuredFromMetadata(metadata));
      if (capture === null) continue;
      hits.push({
        rootAgentId,
        source: 'message.structured_response',
        agentId: typeof record.agentId === 'string' ? record.agentId : null,
        goal: goal.slice(0, 160),
        totalCents: capture.totalCents,
        confirmationId: capture.confirmationId,
        merchant: capture.merchant,
        amountKey: capture.amountKey,
        confirmationKey: capture.confirmationKey,
      });
    }

    const purchaseSpendCleared = purchases
      .map((purchase) => asRecord(purchase))
      .filter((purchase): purchase is Record<string, unknown> => purchase !== null)
      .filter((purchase) => purchase.status === 'CLEARED')
      .map((purchase) => ({
        totalCents: typeof purchase.totalCents === 'number' ? purchase.totalCents : 0,
        provider: typeof purchase.provider === 'string' ? purchase.provider : '',
        merchant: typeof purchase.merchant === 'string' ? purchase.merchant : '',
      }));

    return { hits, queryHit, goal, purchaseSpendCleared, error: null };
  } catch (error) {
    return {
      hits: [],
      queryHit: false,
      goal: '',
      purchaseSpendCleared: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const { concurrency, query, idsPath } = parseArgs(process.argv.slice(2));
  process.env.TRACE_ARCHIVE_BACKEND = process.env.TRACE_ARCHIVE_BACKEND || 'r2';
  process.env.TRACE_ARCHIVE_ENABLED = process.env.TRACE_ARCHIVE_ENABLED || 'true';

  const ids = JSON.parse(readFileSync(idsPath, 'utf8')) as string[];
  console.error(`scanning ${ids.length} end fixtures concurrency=${concurrency} query=${query ?? '*'}`);

  let done = 0;
  const allHits: Hit[] = [];
  const queryRoots: Array<{ rootAgentId: string; goal: string }> = [];
  const clearedFromFixtures: Array<{
    rootAgentId: string;
    totalCents: number;
    provider: string;
    merchant: string;
  }> = [];
  let errors = 0;
  let missing = 0;

  await mapPool(ids, concurrency, async (rootAgentId) => {
    const result = await scanBundle(rootAgentId, query);
    done += 1;
    if (done % 100 === 0 || done === ids.length) {
      console.error(`progress ${done}/${ids.length} hits=${allHits.length} errors=${errors}`);
    }
    if (result.error === 'missing') missing += 1;
    else if (result.error !== null) errors += 1;
    if (result.queryHit) queryRoots.push({ rootAgentId, goal: result.goal.slice(0, 160) });
    allHits.push(...result.hits);
    for (const purchase of result.purchaseSpendCleared) {
      clearedFromFixtures.push({ rootAgentId, ...purchase });
    }
    return result;
  });

  const byConf = new Map<string, Hit>();
  for (const hit of allHits) {
    const key = hit.confirmationId.trim().toLowerCase();
    if (!byConf.has(key)) byConf.set(key, hit);
  }
  const unique = [...byConf.values()].sort((a, b) => b.totalCents - a.totalCents);
  const totalCents = unique.reduce((sum, hit) => sum + hit.totalCents, 0);

  const amazonish = unique.filter(
    (hit) =>
      /amazon|beanie|socks|toilet|speaker|book|shantaram/i.test(hit.goal) ||
      /amazon/i.test(hit.merchant) ||
      /^\d{3}-\d{7}-\d{7}$/.test(hit.confirmationId)
  );

  const summary = {
    scanned: ids.length,
    missing,
    errors,
    extractableRaw: allHits.length,
    uniqueConfirmations: unique.length,
    uniqueTotalCents: totalCents,
    uniqueTotalUsd: totalCents / 100,
    amazonishCount: amazonish.length,
    amazonish,
    topHits: unique.slice(0, 40),
    query,
    queryHitCount: queryRoots.length,
    queryRoots: queryRoots.slice(0, 40),
    clearedPurchaseSpendInFixtures: {
      count: clearedFromFixtures.length,
      totalCents: clearedFromFixtures.reduce((sum, row) => sum + row.totalCents, 0),
      sample: clearedFromFixtures.slice(0, 20),
    },
  };
  writeFileSync('/tmp/r2-gmv-scan.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
