/**
 * Tilion live-view handoffs mint their view token server-side. The worker
 * sends a redacted browserUrl, and a stored Tilion debugUrl expires after
 * 1800 s, so create and refresh must call Tilion's /view-token themselves.
 * In-process: a local fake Tilion API stands behind TILION_BASE_URL.
 */
import { randomUUID } from 'crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '../../providers/database';
import {
  createAuthAssistanceRequest,
  refreshAuthAssistanceSession,
} from '../../domains/auth-assistance/service';

type TestCase = [string, () => Promise<void>];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function withFakeTilion<T>(run: (minted: string[]) => Promise<T>): Promise<T> {
  const minted: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const viewToken = /^\/v1\/session\/([^/]+)\/view-token$/.exec(url.pathname);
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && viewToken) {
      const token = `view-${minted.length + 1}`;
      minted.push(token);
      res.end(
        JSON.stringify({ live_view_url: `/v1/session/${viewToken[1]}/live-view?token=${token}` })
      );
      return;
    }
    if (req.method === 'GET' && /\/status$/.test(url.pathname)) {
      const now = Math.floor(Date.now() / 1000);
      res.end(
        JSON.stringify({ state: 'ready', created_at: now - 60, expires_at: now + 3600, ttl: 3660 })
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ detail: 'No such session' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const previous = { base: process.env.TILION_BASE_URL, key: process.env.TILION_API_KEY };
  process.env.TILION_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.TILION_API_KEY = 'fake-tilion-key';
  try {
    return await run(minted);
  } finally {
    if (previous.base === undefined) delete process.env.TILION_BASE_URL;
    else process.env.TILION_BASE_URL = previous.base;
    if (previous.key === undefined) delete process.env.TILION_API_KEY;
    else process.env.TILION_API_KEY = previous.key;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testTilionLiveViewIsMintedServerSide(): Promise<void> {
  const userId = `auth-assist-tilion-${randomUUID().slice(0, 8)}`;
  await prisma.user.create({ data: { userId } });
  try {
    const agent = await prisma.agent.create({
      data: { userId, goal: 'Tilion login handoff', status: 'PAUSED', temporalWorkflowId: null },
    });
    const context = await prisma.browserContext.create({
      data: { userId, contextId: `fixture-context-${randomUUID()}` },
    });
    const session = await prisma.browserSession.create({
      data: {
        contextId: context.id,
        agentId: agent.id,
        sessionId: `sess_${randomUUID().replace(/-/g, '')}`,
        status: 'ACTIVE',
        provider: 'tilion',
        debugUrl: 'https://back.tilion.dev/v1/session/x/live-view?token=expired-stored',
      },
    });
    await withFakeTilion(async (minted) => {
      const created = await createAuthAssistanceRequest(userId, {
        agentId: agent.id,
        authRealm: 'example.com',
        mode: 'live_view',
        browserSessionId: session.id,
        // What the worker now sends: never a usable token.
        browserUrl: 'https://back.tilion.dev/v1/session/x/live-view?token=REDACTED',
      });
      assert(minted.length === 1, `create minted ${minted.length} view tokens`);
      assert(
        created.handoff.liveViewUrl?.includes('token=view-1') === true,
        `handoff did not use the minted URL: ${created.handoff.liveViewUrl}`
      );
      const attention = await prisma.agentAttentionRequest.findFirstOrThrow({ where: { userId } });
      const stored = JSON.stringify(attention.metadata);
      assert(
        stored.includes('token=view-1'),
        'stored browserUrl/liveViewUrl is not the minted one'
      );
      assert(!stored.includes('REDACTED'), 'the worker-supplied (redacted) browserUrl was stored');

      const refreshed = await refreshAuthAssistanceSession(created.request.id, userId);
      assert(minted.length === 2, `refresh minted ${minted.length - 1} view tokens`);
      assert(
        refreshed.liveViewUrl?.includes('token=view-2') === true,
        `refresh reused a stale URL: ${refreshed.liveViewUrl}`
      );
    });
  } finally {
    await prisma.agentAttentionRequest.deleteMany({ where: { userId } });
    await prisma.browserContext.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

export const authAssistanceTilionTests: TestCase[] = [
  [
    'Tilion live-view handoff mints the view token server-side on create and refresh',
    testTilionLiveViewIsMintedServerSide,
  ],
];
