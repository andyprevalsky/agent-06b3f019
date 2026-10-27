import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { prisma } from '../../providers/database';
import {
  persistLockedToolLifecycleMessage,
  persistToolLifecycleMessage,
} from '../../providers/toolLifecycleMessages';
import { findMessages } from '../../domains/agents/repo';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';

type TestMetadata = {
  [key: string]: unknown;
  userPause?: { reason?: unknown; recordedAt?: unknown; browserCleanup?: unknown };
};
const report = (...parts: string[]): void => {
  process.stdout.write(`${parts.join(' ')}\n`);
};
const reportError = (error: unknown): void => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
};

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
    assert.equal((rows[0].metadata as unknown as TestMetadata).errorCode, 'ORIGINAL');
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
        ['ERROR', 'FINISHED'].includes(String((row.metadata as unknown as TestMetadata).toolStatus))
      );
      assert.equal(terminals.length, 1, `one terminal in ordering pauseFirst=${pauseFirst}`);
      assert.equal((terminals[0].metadata as unknown as TestMetadata).userPause?.reason, 'user');
      assert.ok(
        terminals[0].text.startsWith(pauseFirst ? 'original partial result' : 'completed result')
      );
    }
    // B3: A's annotation is invisible while B commits a newer ordinary row.
    await prisma.message.deleteMany({ where: { agentId: id } });
    const oldResult = await seed();
    let releaseAnnotation!: () => void;
    let annotationWritten!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseAnnotation = resolve;
    });
    const written = new Promise<void>((resolve) => {
      annotationWritten = resolve;
    });
    let annotationPid = 0;
    let ordinaryPid = 0;
    const annotation = prisma.$transaction(async (tx) => {
      annotationPid = (
        await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
      )[0].pid;
      const result = await persistLockedToolLifecycleMessage(tx, params, identity);
      annotationWritten();
      await held;
      return result;
    });
    let annotatedAtCommit;
    try {
      await written;
      // Different transaction/session and a later real clock, not a fabricated watermark.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const newer = await prisma.$transaction(async (tx) => {
        ordinaryPid = (
          await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        )[0].pid;
        return tx.message.create({
          data: {
            agentId: id,
            workflowGeneration: id,
            role: 'ASSISTANT',
            text: 'newer independent result',
            timestamp: new Date(),
          },
        });
      });
      assert.notEqual(
        annotationPid,
        ordinaryPid,
        'held annotation and ordinary commit use two SQL sessions'
      );
      const firstPoll = await findMessages(id, oldResult.timestamp);
      assert.deepEqual(
        firstPoll.map((row) => row.id),
        [newer.id]
      );
      releaseAnnotation();
      annotatedAtCommit = (await annotation).message;
      assert.ok(
        Date.parse(
          String((annotatedAtCommit.metadata as unknown as TestMetadata).userPause?.recordedAt)
        ) < newer.timestamp.getTime()
      );
      const afterCommit = await findMessages(id, newer.timestamp);
      assert.deepEqual(
        afterCommit.map((row) => row.id),
        [oldResult.id],
        'B3: a late committed annotation must replay after the ordinary cursor advances'
      );
      assert.equal(afterCommit[0].timestamp.getTime(), oldResult.timestamp.getTime());
      assert.equal((afterCommit[0].metadata as unknown as TestMetadata).errorCode, 'ORIGINAL');
      assert.ok(afterCommit[0].text.startsWith(oldResult.text));
      // Without an acknowledgement, another poll must still replay it for a lost/restarted reader.
      assert.deepEqual(
        (await findMessages(id, newer.timestamp)).map((row) => row.id),
        [oldResult.id]
      );
      const root = resolve(__dirname, '../../../..');
      const consumer = execFileSync(
        resolve(root, 'agents/venv/bin/python'),
        [resolve(root, 'agents/tests/blackbox/pause_control_provenance.py'), 'replay'],
        {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 2 * 1024 * 1024,
          input: JSON.stringify({
            initial: [oldResult],
            firstPoll,
            secondPoll: afterCommit,
            originalText: oldResult.text,
          }),
        }
      );
      assert.match(consumer, /B3_CONSUMER_PASS/);
      report(consumer.trim());
      report(
        'B3_PASS',
        JSON.stringify({
          annotationPid,
          ordinaryPid,
          annotationClock: (annotatedAtCommit.metadata as unknown as TestMetadata).userPause
            ?.recordedAt,
          ordinaryCursor: newer.timestamp.toISOString(),
          replayedResultId: oldResult.id,
          originalClock: oldResult.timestamp.toISOString(),
        })
      );
    } finally {
      releaseAnnotation();
      await annotation;
    }
    // B4: replay covers the late-commit window, not every older annotation on every poll.
    const pauseClock = Date.parse(
      String((annotatedAtCommit.metadata as unknown as TestMetadata).userPause?.recordedAt)
    );
    assert.deepEqual(
      (await findMessages(id, new Date(pauseClock + 30_000))).map((row) => row.id),
      [oldResult.id],
      'B4: an annotation still replays to a cursor beyond the 10s transaction timeout'
    );
    const later = await prisma.message.create({
      data: {
        agentId: id,
        workflowGeneration: id,
        role: 'ASSISTANT',
        text: 'later ordinary result',
        timestamp: new Date(pauseClock + 60 * 60_000 + 1_000),
      },
    });
    assert.deepEqual(
      (await findMessages(id, new Date(pauseClock + 60 * 60_000))).map((row) => row.id),
      [later.id],
      'B4: a consumed annotation an hour behind the cursor is not replayed on every poll'
    );
    report('B4_PASS: bounded pause replay keeps newer rows and drops stale annotations');
    report(
      'browser user pause real PostgreSQL: PASS (10 concurrent annotations, SQL polling, both completion/pause lock orderings)'
    );
  } finally {
    await prisma.agent.delete({ where: { id } });
    await prisma.$disconnect();
  }
}
main().catch(async (error) => {
  reportError(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
