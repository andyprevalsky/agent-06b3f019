import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';

// The Message trajectory trigger upserts the agent's AgentTrajectoryAgent row.
// An open transaction that wrote one message must not block other message
// writes for the same agent when the stored goal/title are already current,
// while a real goal change still reaches that row.

const report = (...parts: string[]): void => {
  process.stdout.write(`${parts.join(' ')}\n`);
};

async function storedAgent(agentId: string) {
  return prisma.$queryRaw<Array<{ agentGoal: string; agentTitle: string | null }>>`
    SELECT "agentGoal", "agentTitle" FROM "AgentTrajectoryAgent" WHERE "agentId" = ${agentId}
  `;
}

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
      userId: `trajectory-lock-${id}`,
      goal: 'first goal',
      title: 'First title',
      status: 'ACTIVE',
      busId: id,
    },
  });
  try {
    const first = await prisma.message.create({
      data: { agentId: id, role: 'TOOL', text: 'first', timestamp: new Date() },
    });
    assert.deepEqual(await storedAgent(id), [
      { agentGoal: 'first goal', agentTitle: 'First title' },
    ]);

    let release!: () => void;
    let written!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const updated = new Promise<void>((resolve) => {
      written = resolve;
    });
    const annotation = prisma.$transaction(
      async (tx) => {
        await tx.message.update({ where: { id: first.id }, data: { text: 'first annotated' } });
        written();
        await held;
      },
      { timeout: 20_000 }
    );
    try {
      await updated;
      // A regression waits on the held row lock; lock_timeout turns that into a fast failure.
      const newer = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '2000ms'`;
        return tx.message.create({
          data: { agentId: id, role: 'ASSISTANT', text: 'newer', timestamp: new Date() },
        });
      });
      assert.equal(newer.agentId, id);
    } finally {
      release();
      await annotation;
    }

    await prisma.agent.update({ where: { id }, data: { goal: 'second goal' } });
    await prisma.message.create({
      data: { agentId: id, role: 'ASSISTANT', text: 'after goal change', timestamp: new Date() },
    });
    assert.deepEqual(
      await storedAgent(id),
      [{ agentGoal: 'second goal', agentTitle: 'First title' }],
      'a changed goal must still update the stored agent row'
    );
    report(
      'agent trajectory agent lock: PASS (held message write does not block same-agent insert)'
    );
  } finally {
    await prisma.$executeRaw`DELETE FROM "AgentTrajectoryAgent" WHERE "agentId" = ${id}`;
    await prisma.message.deleteMany({ where: { agentId: id } });
    await prisma.agent.delete({ where: { id } });
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  await prisma.$disconnect();
  process.exitCode = 1;
});
