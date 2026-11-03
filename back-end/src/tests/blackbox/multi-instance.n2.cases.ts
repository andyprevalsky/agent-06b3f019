/**
 * Multi-instance cases for the N=2 low-severity sweep (lane S26): each runs
 * the real module in two processes released together by the harness barrier.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { concurrently } from './multi-instance.harness';

interface N2Context {
  test: (name: string, fn: () => Promise<void>) => Promise<void>;
  assert: (cond: unknown, msg: string) => void;
  userId: string;
  integrationIds: string[];
}

export async function runN2Cases({
  test,
  assert,
  userId,
  integrationIds,
}: N2Context): Promise<void> {
  await test('Claude Code sandbox creates run one at a time across instances', async () => {
    const [a, b] = await concurrently([
      ['e2b-create-slot', ['1500']],
      ['e2b-create-slot', ['1500']],
    ]);
    assert(
      a.error === undefined && b.error === undefined,
      `creates failed: ${JSON.stringify([a, b])}`
    );
    const [first, second] = [a, b].sort((x, y) => Number(x.start) - Number(y.start));
    assert(
      Number(second.start) >= Number(first.end),
      `creates overlapped across instances: ${JSON.stringify([first, second])}`
    );
  });

  await test('a slow messaging upload part keeps its claim, so it is processed once', async () => {
    const integration = await prisma.integration.create({
      data: { userId, name: 'imessage', type: 'DATA_SOURCE', status: 'SYNCING', config: {} },
    });
    integrationIds.push(integration.id);
    const uploadId = `mi-upload-${randomUUID()}`;
    await prisma.messagingUploadJob.create({
      data: {
        userId,
        integrationId: integration.id,
        platform: 'imessage',
        uploadId,
        part: 0,
        parts: 1,
        payload: [
          {
            contact_id: `+1555${String(Date.now()).slice(-7)}`,
            contact_name: 'Multi-instance contact',
            messages: [
              { id: 1, text: 'slow part', date: 700_000_000_000_000_000, is_from_me: true },
            ],
          },
        ],
        accessedAt: null,
        syncComplete: true,
        contacts: 1,
        messages: 1,
      },
    });
    try {
      // A's insert stalls 9s on a 3s claim lease; B drains at 5s, after that lease expired.
      const results = await concurrently([
        ['messaging-slow-drain', ['3000', '9000', '0']],
        ['messaging-slow-drain', ['3000', '9000', '5000']],
      ]);
      assert(
        results.every((r) => r.error === undefined),
        `drains failed: ${JSON.stringify(results)}`
      );
      const part = await prisma.messagingUploadJob.findFirstOrThrow({ where: { uploadId } });
      assert(part.processedAt !== null, 'the part must be processed');
      assert(
        part.attempts === 1,
        `a renewed claim must not be taken over and re-run (attempts ${part.attempts})`
      );
    } finally {
      await prisma.messagingUploadJob.deleteMany({ where: { uploadId } });
      await prisma.messageRecord.deleteMany({ where: { person: { userId } } });
      await prisma.person.deleteMany({ where: { userId } });
    }
  });

  await test('two instances seeding the benchmark catalog at boot both succeed', async () => {
    const names = (await prisma.benchmarkTask.findMany({ select: { name: true }, take: 5 })).map(
      (row) => row.name
    );
    await prisma.benchmarkTask.deleteMany({ where: { name: { in: names } } });
    const results = await concurrently([
      ['catalog-seed', []],
      ['catalog-seed', []],
    ]);
    assert(
      results.every((r) => r.error === undefined),
      `a concurrent seed must not fail: ${JSON.stringify(results)}`
    );
    const restored = await prisma.benchmarkTask.count({ where: { name: { in: names } } });
    assert(restored === names.length, `missing tasks re-seeded (${restored}/${names.length})`);
  });

  await test('one error-alert signature posts once across instances', async () => {
    // fingerprint() normalizes UUIDs and digits, so vary the signature with letters.
    const message = `multi-instance alert ${randomUUID().replace(/[^a-f]/g, '')}`;
    const results = await concurrently([
      ['error-alert', [message]],
      ['error-alert', [message]],
    ]);
    const sent = results.reduce((sum, r) => sum + Number(r.sent ?? 0), 0);
    assert(sent === 1, `one alert per signature across instances, got ${sent}`);
  });

  await test('concurrent first x402 payments from one wallet resolve to one user', async () => {
    const wallet = `0x${randomUUID().replace(/-/g, '')}`;
    try {
      const results = await concurrently([
        ['x402-wallet-user', [wallet]],
        ['x402-wallet-user', [wallet]],
      ]);
      assert(
        results.every((r) => r.userId === wallet.toLowerCase()),
        `both first payments must resolve the wallet user: ${JSON.stringify(results)}`
      );
    } finally {
      await prisma.user.deleteMany({ where: { userId: wallet.toLowerCase() } });
    }
  });
}
