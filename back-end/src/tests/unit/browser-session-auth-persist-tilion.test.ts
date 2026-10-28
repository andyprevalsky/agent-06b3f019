#!/usr/bin/env tsx
/**
 * The close-time sign-in harvest of a Tilion session mints a fresh connect URL.
 * Tilion connect tokens last 1800 s while a session lives up to 14400 s, so the
 * create-time wsUrl stored on the row has usually expired by close; connecting
 * with it would lose the user's sign-in instead of persisting it.
 *
 *   persistSignedInBrowserState ─GET /connect─▶ fake Tilion ─▶ ws://127.0.0.1:<cdp>/…?token=fresh
 *                               └─connectOverCDP(fresh URL)─▶ upgrade recorder
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../providers/database';
import { persistSignedInBrowserState } from '../../providers/browser/sessionAuthPersist';
import {
  completeCloudBrowserSignIn,
  deleteCloudBrowserSignInEvidence,
} from '../helpers/browser-sign-in-evidence';
import { FakeTilionServer } from './tilion-fake-server.support';

async function withSignedInTilionSession<T>(
  run: (session: { sessionId: string }) => Promise<T>
): Promise<T> {
  const userId = `auth-persist-tilion-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  try {
    const agentId = randomUUID();
    await prisma.agent.create({
      data: { id: agentId, userId, goal: 'Harvest a Tilion sign-in', status: 'ACTIVE' },
    });
    const context = await prisma.browserContext.create({ data: { userId } });
    const session = await prisma.browserSession.create({
      data: {
        contextId: context.id,
        agentId,
        sessionId: `sess_${randomUUID().replace(/-/g, '')}`,
        // The create-time URL: its token has expired by the time the session closes.
        wsUrl: 'wss://tilion.invalid/v1/session/x/cdp?token=expired-create-token',
        provider: 'tilion',
        status: 'ACTIVE',
        providerProfileSource: 'tilion_ephemeral',
      },
    });
    await completeCloudBrowserSignIn({
      userId,
      agentId,
      browserSessionId: session.id,
      steelSessionId: session.sessionId,
      authRealm: 'https://example.com/login',
    });
    return await run({ sessionId: session.sessionId });
  } finally {
    await deleteCloudBrowserSignInEvidence(userId);
    await prisma.browserSession.deleteMany({ where: { context: { userId } } });
    await prisma.browserContext.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

async function tilionHarvestMintsFreshConnectUrl(): Promise<void> {
  const upgrades: string[] = [];
  const cdp = createServer();
  cdp.on('upgrade', (req, socket) => {
    upgrades.push(req.url ?? '');
    socket.destroy();
  });
  await new Promise<void>((resolve) => cdp.listen(0, '127.0.0.1', resolve));
  const cdpPort = (cdp.address() as AddressInfo).port;
  const tilion = new FakeTilionServer();
  await tilion.start();
  tilion.route('GET', /\/connect$/, (request) => ({
    status: 200,
    body: {
      connect_url: `ws://127.0.0.1:${cdpPort}${request.path.replace(/\/connect$/, '/cdp')}?token=fresh`,
    },
  }));
  const previous = { base: process.env.TILION_BASE_URL, key: process.env.TILION_API_KEY };
  process.env.TILION_BASE_URL = tilion.baseUrl;
  process.env.TILION_API_KEY = 'fake-tilion-key';
  try {
    await withSignedInTilionSession(async ({ sessionId }) => {
      // The recorder refuses the handshake, so the harvest itself fails after connecting.
      await persistSignedInBrowserState(sessionId).catch(() => undefined);
      assert.equal(tilion.callsTo('GET', /\/connect$/).length, 1, 'no fresh connect URL minted');
      assert.deepEqual(upgrades, [`/v1/session/${sessionId}/cdp?token=fresh`]);
    });
  } finally {
    await tilion.stop();
    await new Promise<void>((resolve) => cdp.close(() => resolve()));
    if (previous.base === undefined) delete process.env.TILION_BASE_URL;
    else process.env.TILION_BASE_URL = previous.base;
    if (previous.key === undefined) delete process.env.TILION_API_KEY;
    else process.env.TILION_API_KEY = previous.key;
  }
}

tilionHarvestMintsFreshConnectUrl()
  .then(() => process.stdout.write('browser-session-auth-persist-tilion: ok\n'))
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
