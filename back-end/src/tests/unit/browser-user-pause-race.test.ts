import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import {
  persistLockedToolLifecycleMessage,
  persistToolLifecycleMessage,
} from '../../providers/toolLifecycleMessages';
import { findMessages } from '../../domains/agents/repo';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';

async function main() {
  assert.equal(
    nonLocalDatabaseReason(process.env.DATABASE_URL ?? ''),
    null,
    'requires an owned local test DB'
  );
  const id = randomUUID();
  await prisma.agent.create({
    data: {
      id,
      userId: `pause-test-${id}`,
      goal: 'pause race fixture',
      status: 'ACTIVE',
      busId: id,
      temporalWorkflowId: id,
    },
  });
  const identity = { toolCallId: 'call', workflowGeneration: id };
  const params = {
    agentId: id,
    role: 'TOOL' as const,
    text: 'User pause',
    enforceCurrentWorkflowGeneration: true,
    metadata: {
      toolName: 'spawn_browser_agent',
      toolCallId: 'call',
      toolStatus: 'ERROR',
      workflowGeneration: id,
      userPauseRequested: true,
    },
  };
  const seed = async (status = 'ERROR') =>
    prisma.message.create({
      data: {
        agentId: id,
        workflowGeneration: id,
        role: 'TOOL',
        text: 'original partial result and error',
        timestamp: new Date('2026-01-01Z'),
        metadata: {
          toolCallId: 'call',
          toolName: 'spawn_browser_agent',
          workflowGeneration: id,
          toolStatus: status,
          error: true,
          errorCode: 'ORIGINAL',
        },
      },
    });
  try {
    const original = await seed();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => persistToolLifecycleMessage(params, identity))
    );
    assert.equal(results.filter((r) => r.updated).length, 1, 'only one concurrent pause updates');
    const rows = await prisma.message.findMany({ where: { agentId: id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, original.id);
    assert.equal(rows[0].timestamp.getTime(), original.timestamp.getTime());
    assert.ok(rows[0].text.startsWith(original.text));
    assert.equal((rows[0].metadata as any).errorCode, 'ORIGINAL');
    const delivered = await findMessages(id, new Date('2026-01-02Z'));
    assert.equal(
      delivered.length,
      1,
      'SQL poll discovers changed original row without re-timestamping it'
    );
    for (const pauseFirst of [false, true]) {
      await prisma.message.deleteMany({ where: { agentId: id } });
      await seed('IN_PROGRESS');
      let release!: () => void;
      let entered!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const completion = {
        ...params,
        text: 'completed result',
        metadata: { ...params.metadata, toolStatus: 'FINISHED', userPauseRequested: false },
      };
      const first = prisma.$transaction(async (tx) => {
        const result = await persistLockedToolLifecycleMessage(
          tx,
          pauseFirst ? params : completion,
          identity
        );
        entered();
        await hold;
        return result;
      });
      await ready;
      const second = persistToolLifecycleMessage(pauseFirst ? completion : params, identity);
      release();
      await Promise.all([first, second]);
      const final = await prisma.message.findMany({ where: { agentId: id } });
      const terminals = final.filter((row) =>
        ['ERROR', 'FINISHED'].includes((row.metadata as any).toolStatus)
      );
      assert.equal(terminals.length, 1, `one terminal in ordering pauseFirst=${pauseFirst}`);
      assert.equal((terminals[0].metadata as any).userPause.reason, 'user');
      assert.ok(
        terminals[0].text.startsWith(pauseFirst ? 'original partial result' : 'completed result')
      );
    }
    console.log(
      'browser user pause real PostgreSQL: PASS (10 concurrent annotations, SQL polling, both completion/pause lock orderings)'
    );
  } finally {
    await prisma.agent.delete({ where: { id } });
    await prisma.$disconnect();
  }
}
main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
