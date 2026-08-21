/**
 * Backfill platform GMV from historical agent/browser structured outputs.
 *
 * Scans:
 *   1. Agent.structuredResponse (COMPLETED agents)
 *   2. Message.metadata.structured_response on TOOL FINISHED rows
 *
 * Requires BOTH a USD amount and a confirmation/order id. Dedupes against
 * existing PurchaseSpend fingerprints and AgentCard rows for the same agent+amount.
 *
 * Usage:
 *   cd back-end && npx tsx scripts/backfill-structured-gmv.ts --dry-run
 *   cd back-end && npx tsx scripts/backfill-structured-gmv.ts --apply
 *   cd back-end && npx tsx scripts/backfill-structured-gmv.ts --apply --since 2026-05-01
 */

import 'dotenv/config';

import { prisma } from '../src/providers/database';
import { extractStructuredGmv } from '../src/domains/purchases/structuredGmvExtract';
import { recordStructuredGmv } from '../src/domains/purchases/structuredGmv';

function parseArgs(argv: string[]): { apply: boolean; since: Date | null; limit: number } {
  const apply = argv.includes('--apply');
  const sinceIdx = argv.indexOf('--since');
  const limitIdx = argv.indexOf('--limit');
  const sinceRaw = sinceIdx >= 0 ? argv[sinceIdx + 1] : undefined;
  const limitRaw = limitIdx >= 0 ? argv[limitIdx + 1] : undefined;
  const since =
    sinceRaw !== undefined && sinceRaw !== '' ? new Date(`${sinceRaw}T00:00:00.000Z`) : null;
  const limit =
    limitRaw !== undefined && /^\d+$/.test(limitRaw) ? Number.parseInt(limitRaw, 10) : 50_000;
  if (!apply && !argv.includes('--dry-run')) {
    console.error('Pass --dry-run or --apply');
    process.exit(2);
  }
  if (since !== null && Number.isNaN(since.getTime())) {
    console.error(`Invalid --since date: ${sinceRaw}`);
    process.exit(2);
  }
  return { apply, since, limit };
}

function structuredFromMetadata(metadata: unknown): unknown {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  const structured = record.structured_response ?? record.structuredResponse;
  return structured === undefined ? null : structured;
}

async function main(): Promise<void> {
  const { apply, since, limit } = parseArgs(process.argv.slice(2));
  const createdAtFilter = since === null ? undefined : { gte: since };

  const agents = await prisma.agent.findMany({
    where: {
      status: 'COMPLETED',
      structuredResponse: { not: null },
      ...(createdAtFilter === undefined ? {} : { updatedAt: createdAtFilter }),
    },
    select: {
      id: true,
      userId: true,
      structuredResponse: true,
      updatedAt: true,
    },
    take: limit,
    orderBy: { updatedAt: 'desc' },
  });

  const messages = await prisma.message.findMany({
    where: {
      role: 'TOOL',
      ...(createdAtFilter === undefined ? {} : { createdAt: createdAtFilter }),
      AND: [
        { metadata: { path: ['toolStatus'], equals: 'FINISHED' } },
        {
          OR: [
            { metadata: { path: ['structured_response'], not: null } },
            { metadata: { path: ['structuredResponse'], not: null } },
          ],
        },
      ],
    },
    select: {
      id: true,
      agentId: true,
      metadata: true,
      createdAt: true,
      agent: { select: { userId: true } },
    },
    take: limit,
    orderBy: { createdAt: 'desc' },
  });

  type Candidate = {
    userId: string;
    agentId: string;
    structured: unknown;
    source: string;
    at: Date;
  };

  const candidates: Candidate[] = [];
  for (const agent of agents) {
    if (agent.structuredResponse === null) continue;
    candidates.push({
      userId: agent.userId,
      agentId: agent.id,
      structured: agent.structuredResponse,
      source: 'backfill.agent.structuredResponse',
      at: agent.updatedAt,
    });
  }
  for (const message of messages) {
    const structured = structuredFromMetadata(message.metadata);
    if (structured === null) continue;
    candidates.push({
      userId: message.agent.userId,
      agentId: message.agentId,
      structured,
      source: 'backfill.message.structured_response',
      at: message.createdAt,
    });
  }

  let extractable = 0;
  let recorded = 0;
  let skipped = 0;
  let created = 0;
  const samples: Array<{ agentId: string; totalCents: number; confirmationId: string; source: string }> =
    [];

  for (const candidate of candidates) {
    const capture = extractStructuredGmv(candidate.structured);
    if (capture === null) continue;
    extractable += 1;
    if (samples.length < 20) {
      samples.push({
        agentId: candidate.agentId,
        totalCents: capture.totalCents,
        confirmationId: capture.confirmationId,
        source: candidate.source,
      });
    }
    if (!apply) continue;
    const result = await recordStructuredGmv({
      userId: candidate.userId,
      agentId: candidate.agentId,
      structured: candidate.structured,
      source: candidate.source,
      occurredAt: candidate.at,
    });
    if (result.status === 'skipped') {
      skipped += 1;
    } else {
      recorded += 1;
      if (result.created) created += 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        since: since?.toISOString() ?? null,
        agentRows: agents.length,
        messageRows: messages.length,
        candidates: candidates.length,
        extractable,
        recorded,
        created,
        skipped,
        samples,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
