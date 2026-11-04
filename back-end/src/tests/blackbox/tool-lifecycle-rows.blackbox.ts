#!/usr/bin/env tsx
/**
 * Black-box contract: a tool-lifecycle write reads only the tool call's
 * lifecycle rows, never its child-scoped transcript rows.
 *
 * A multi-day code agent writes one transcript batch row (no toolStatus, large
 * `code_agent_events` metadata) per flush under the spawn's toolCallId. Every
 * lifecycle write for that toolCallId (status rows, the final task_complete)
 * loaded all of them, full rows, under the call's advisory lock inside a 10s
 * transaction: the work grew with run time until the final result failed to
 * persist. The candidates a lifecycle write needs (duplicates, fences, pause
 * annotations, background stamps) all carry a toolStatus.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { persistLockedToolLifecycleMessage } from '../../providers/toolLifecycleMessages';

const TRANSCRIPT_ROWS = 300;

function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  const host = /@([^:/?]+)/.exec(url)?.[1] ?? '';
  assert.ok(
    ['localhost', '127.0.0.1', '::1'].includes(host),
    `refusing to write fixtures outside a local database (host=${host || 'unset'})`
  );
}

/** Counts every Message row a transaction client materializes in the application. */
function countingTx(tx: Prisma.TransactionClient, loaded: { rows: number }) {
  const message = new Proxy(tx.message, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key !== 'findMany' || typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        const rows = (await value.apply(target, args)) as unknown[];
        loaded.rows += rows.length;
        return rows;
      };
    },
  });
  return new Proxy(tx, {
    get(target, key, receiver) {
      return key === 'message' ? message : Reflect.get(target, key, receiver);
    },
  }) as Prisma.TransactionClient;
}

async function main(): Promise<void> {
  assertLocalDatabase();
  const user = await prisma.user.create({ data: { userId: randomUUID() }, select: { id: true } });
  const agentId = randomUUID();
  const toolCallId = `tc-lifecycle-${randomUUID().slice(0, 8)}`;
  await prisma.agent.create({
    data: {
      id: agentId,
      userId: user.id,
      goal: 'tool lifecycle row scan',
      status: 'ACTIVE',
      busId: agentId,
      temporalWorkflowId: agentId,
    },
  });
  try {
    const base = { toolCallId, toolName: 'spawn_claude_code_agent', task_id: 'cc-task' };
    await prisma.message.create({
      data: {
        agentId,
        workflowGeneration: agentId,
        role: 'TOOL',
        text: 'Goal: build it',
        metadata: { ...base, toolStatus: 'IN_PROGRESS', title: 'Claude Code Started' },
      },
    });
    const events = Array.from({ length: 40 }, (_, i) => ({
      type: 'text',
      seq: i,
      text: 'x'.repeat(100),
    }));
    await prisma.message.createMany({
      data: Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => ({
        agentId,
        workflowGeneration: agentId,
        role: 'TOOL' as const,
        text: `transcript ${i}`,
        metadata: {
          ...base,
          title: 'Transcript',
          subAgentId: 'cc-task',
          isCodeTranscript: true,
          action_type: 'code_transcript',
          code_agent_events: events,
        },
      })),
    });

    const terminal = {
      agentId,
      role: 'TOOL' as const,
      text: 'done',
      metadata: {
        ...base,
        toolStatus: 'FINISHED',
        title: 'Task Completed',
        action_type: 'task_complete',
      },
    };
    const identity = { toolCallId, workflowGeneration: agentId };
    const persist = async () => {
      const loaded = { rows: 0 };
      const result = await prisma.$transaction((tx) =>
        persistLockedToolLifecycleMessage(countingTx(tx, loaded), terminal, identity)
      );
      return { result, loaded: loaded.rows };
    };

    const first = await persist();
    assert.equal(first.result.created, true, 'the terminal row must persist');
    assert.ok(
      first.loaded <= 2,
      `a lifecycle write loaded ${first.loaded} rows for a tool call with 1 lifecycle row and ${TRANSCRIPT_ROWS} transcript rows`
    );

    const retry = await persist();
    assert.equal(retry.result.created, false, 'a retried terminal write must deduplicate');
    assert.equal(
      retry.result.message.id,
      first.result.message.id,
      'the retry must return the stored row'
    );
    assert.ok(retry.loaded <= 3, `the retry loaded ${retry.loaded} rows`);
    process.stdout.write('tool-lifecycle-rows: PASS\n');
  } finally {
    await prisma.message.deleteMany({ where: { agentId } });
    await prisma.agent.delete({ where: { id: agentId } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `tool-lifecycle-rows: FAIL ${error instanceof Error ? error.stack : String(error)}\n`
  );
  process.exit(1);
});
