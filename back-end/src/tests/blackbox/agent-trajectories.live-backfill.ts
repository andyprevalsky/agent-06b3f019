/**
 * Live messages written before the projection triggers existed must be
 * recoverable by the bounded post-deploy backfill. The release migration no
 * longer backfills in one statement: that INSERT ... SELECT over every
 * production message hit the statement timeout (57014) and failed the deploy.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { prisma } from '../../providers/database';
import type { ScopedDbFixture } from '../../providers/traceArchiveFixture';
import {
  backfillLiveMessageSearchBatch,
  indexArchivedTrace,
} from '../../providers/traceArchiveSearchIndex';

// Ids at the top of the UUID space keep this test's scan to its own rows.
const CURSOR_FLOOR = 'ffffffff-ffff-4fff-8fff-000000000000';
const highId = () => `ffffffff-ffff-4fff-8fff-${randomBytes(6).toString('hex')}`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function proveLiveMessageBackfill(ownerId: string): Promise<void> {
  const root = await prisma.agent.create({
    data: { userId: ownerId, goal: 'Pre-trigger root run', source: 'SMS' },
  });
  const child = await prisma.agent.create({
    data: {
      userId: ownerId,
      parentAgentId: root.id,
      goal: 'Pre-trigger child run',
      source: 'WEB',
    },
  });
  const [userMessage, toolMessage, systemMessage, blankMessage] = [
    highId(),
    highId(),
    highId(),
    highId(),
  ];
  await prisma.message.createMany({
    data: [
      { id: userMessage, agentId: root.id, role: 'USER', text: 'Heron launch window is 09:40' },
      { id: toolMessage, agentId: child.id, role: 'TOOL', text: 'Heron deploy failed: E_HERON' },
      { id: systemMessage, agentId: child.id, role: 'SYSTEM', text: 'system prompt text' },
      { id: blankMessage, agentId: child.id, role: 'ASSISTANT', text: '   ' },
    ],
  });
  const ids = [userMessage, toolMessage, systemMessage, blankMessage];
  // Simulate history that predates the triggers.
  await prisma.$executeRaw`DELETE FROM "AgentTrajectorySearch" WHERE "messageId" = ANY(${ids})`;

  const result = spawnSync(
    process.execPath,
    [
      require.resolve('tsx/cli'),
      'scripts/backfill-agent-trajectory-search.ts',
      '--live-messages',
      '--batch-size',
      '2',
      '--after',
      CURSOR_FLOOR,
    ],
    { cwd: resolve(__dirname, '../../..'), env: process.env, encoding: 'utf8', timeout: 120_000 }
  );
  assert(
    result.status === 0,
    `live-message backfill failed:\n${result.stdout ?? ''}${result.stderr ?? ''}`
  );
  const summary = JSON.parse((result.stdout ?? '').trim().split('\n').pop() ?? '{}') as {
    scanned?: number;
    inserted?: number;
    batches?: number;
  };
  assert(
    (summary.scanned ?? 0) >= 4 && (summary.batches ?? 0) >= 2,
    `expected bounded batches over the seeded rows, got ${JSON.stringify(summary)}`
  );

  const rows = await prisma.$queryRaw<
    Array<{
      messageId: string;
      userId: string;
      rootAgentId: string;
      agentId: string;
      surface: string;
    }>
  >`SELECT "messageId", "userId", "rootAgentId", "agentId", "surface"
    FROM "AgentTrajectorySearch" WHERE "messageId" = ANY(${ids})`;
  const byId = new Map(rows.map((row) => [row.messageId, row]));
  const tool = byId.get(toolMessage);
  assert(byId.get(userMessage)?.rootAgentId === root.id, 'root message was not indexed');
  assert(
    tool?.rootAgentId === root.id &&
      tool.agentId === child.id &&
      tool.userId === ownerId &&
      tool.surface === 'WEB',
    `child message indexed with the wrong lineage: ${JSON.stringify(tool)}`
  );
  assert(!byId.has(systemMessage), 'SYSTEM message must never be indexed');
  assert(!byId.has(blankMessage), 'blank message must not be indexed');

  // Idempotent: a second pass adds nothing and never overwrites existing rows.
  await prisma.$executeRaw`UPDATE "AgentTrajectorySearch" SET "searchText" = 'kept'
    WHERE "messageId" = ${userMessage}`;
  let afterId: string | null = CURSOR_FLOOR;
  let reinserted = 0;
  for (;;) {
    const batch = await backfillLiveMessageSearchBatch(afterId, 2);
    if (batch.scanned === 0) break;
    reinserted += batch.inserted;
    afterId = batch.lastMessageId;
  }
  assert(reinserted === 0, `a repeated backfill inserted ${reinserted} rows`);
  const kept = await prisma.$queryRaw<Array<{ searchText: string }>>`
    SELECT "searchText" FROM "AgentTrajectorySearch" WHERE "messageId" = ${userMessage}`;
  assert(kept[0]?.searchText === 'kept', 'a repeated backfill overwrote an existing row');
}

/** Archive indexing must never take over another user's trajectory row. */
export async function proveArchiveCannotTakeOverForeignRow(
  ownerId: string,
  otherId: string
): Promise<void> {
  const messageId = randomUUID();
  const rootAgentId = randomUUID();
  const foreignRootAgentId = randomUUID();
  const capturedAt = new Date();
  await prisma.agentTrajectorySearch.create({
    data: {
      messageId,
      userId: otherId,
      rootAgentId: foreignRootAgentId,
      agentId: foreignRootAgentId,
      surface: 'WEB',
      role: 'ASSISTANT',
      createdAt: capturedAt,
      searchText: 'Foreign private row',
      agentGoal: 'Private',
      traceKind: 'message',
    },
  });
  try {
    await indexArchivedTrace(
      rootAgentId,
      {
        root_agent_id: rootAgentId,
        user_id: ownerId,
        agent_ids: [rootAgentId],
        captured_at: capturedAt.toISOString(),
        rows: {
          Agent: [{ id: rootAgentId, goal: 'Colliding archive', source: 'SMS' }],
          Message: [{ id: messageId, agentId: rootAgentId, role: 'TOOL', text: 'Collision' }],
        },
      } as ScopedDbFixture,
      []
    );
    const row = await prisma.agentTrajectorySearch.findUniqueOrThrow({ where: { messageId } });
    if (
      row.userId !== otherId ||
      row.rootAgentId !== foreignRootAgentId ||
      row.searchText !== 'Foreign private row'
    ) {
      throw new Error('Archive indexing overwrote another user’s trajectory row');
    }
  } finally {
    await prisma.agentTrajectorySearch.deleteMany({ where: { messageId } });
  }
}
