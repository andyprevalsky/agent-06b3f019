#!/usr/bin/env tsx
/**
 * Tilion JIT credentials never open a backend CDP socket: prepare-auth and
 * inject-local-storage return `worker_apply` (the agent worker holds Tilion's
 * only CDP client). The payload must carry the same selected cookie bundle and
 * realm-scoped localStorage the CDP path would inject, and claim nothing injected.
 */
import '../blackbox/assertLocalDatabase';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { prisma } from '../../providers/database';
import {
  buildTilionWorkerApplyPayload,
  WORKER_APPLY_REASON,
} from '../../domains/browser-session/service.worker-apply';
import { injectLocalStorage } from '../../domains/browser-session/service.local-storage';
import { getTaskInfo, prepareSessionCredentials } from '../../domains/browser-session/service';

const REALM = `tilion-${randomUUID().slice(0, 8)}.example`;
const LIVE_EXPIRY_CHROME =
  (BigInt(Math.floor(Date.now() / 1000) + 3600) + 11_644_473_600n) * 1_000_000n;

async function seed(userId: string) {
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  await prisma.cookieBundle.create({
    data: { userId, authRealm: REALM, browserSource: 'chrome', browserProfile: 'Default' },
  });
  await prisma.cookie.createMany({
    data: [
      {
        userId,
        domain: `.${REALM}`,
        name: 'session_token',
        value: 'secret-session',
        path: '/',
        expiresUtc: LIVE_EXPIRY_CHROME,
        isSecure: true,
        isHttpOnly: true,
        browserSource: 'chrome',
        browserProfile: 'Default',
      },
    ],
  });
  const old = new Date(Date.now() - 60_000);
  await prisma.localStorageOrigin.create({
    data: {
      userId,
      // The Mac reader's truncated storage key restores to the same origin.
      origin: `ttps://www.${REALM}`,
      entries: [
        { key: 'theme', value: 'old' },
        { key: 'auth', value: 'a1' },
      ],
      hash: 'h-old',
      updatedAt: old,
    },
  });
  // A second, newer row for the same origin wins on shared keys.
  await prisma.localStorageOrigin.create({
    data: {
      userId,
      origin: `https://www.${REALM}`,
      entries: [{ key: 'theme', value: 'new' }],
      hash: 'h-new',
    },
  });
  // Lookalike origin must never be selected.
  await prisma.localStorageOrigin.create({
    data: {
      userId,
      origin: `https://evil${REALM}`,
      entries: [{ key: 'steal', value: 'x' }],
      hash: 'h-evil',
    },
  });
}

async function cleanup(userId: string, agentId: string) {
  await prisma.browserSession.deleteMany({ where: { agentId } });
  await prisma.browserContext.deleteMany({ where: { userId } });
  await prisma.localStorageOrigin.deleteMany({ where: { userId } });
  await prisma.cookie.deleteMany({ where: { userId } });
  await prisma.cookieBundle.deleteMany({ where: { userId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.user.deleteMany({ where: { userId } });
}

async function run(): Promise<void> {
  const userId = `tilion-worker-apply-${randomUUID()}`;
  const agentId = randomUUID();
  const sessionId = `sess_${randomUUID().replace(/-/g, '')}`;
  const connect = chromium.connectOverCDP;
  let cdpConnects = 0;
  chromium.connectOverCDP = (async () => {
    cdpConnects += 1;
    throw new Error('backend must not open CDP to a Tilion session mid-run');
  }) as typeof chromium.connectOverCDP;
  try {
    await seed(userId);
    const { payload, injection } = await buildTilionWorkerApplyPayload(
      userId,
      `https://www.${REALM}/login`
    );
    assert.equal(payload.provider, 'tilion');
    assert.equal(payload.reason, WORKER_APPLY_REASON);
    assert.deepEqual(
      payload.cookies.map((cookie) => [cookie.name, cookie.value, cookie.domain]),
      [['session_token', 'secret-session', `.${REALM}`]]
    );
    assert.deepEqual(payload.local_storage, [
      {
        origin: `https://www.${REALM}`,
        entries: [
          { key: 'theme', value: 'new' },
          { key: 'auth', value: 'a1' },
        ],
      },
    ]);
    assert.equal(injection.cookies.injected, false, 'the backend injected nothing');
    assert.equal(injection.cookies.authSource, 'cookie_bundle');
    assert.equal(injection.cookies.cookieCount, 1);

    await prisma.agent.create({
      data: { id: agentId, userId, goal: 'tilion worker apply', proxyCountry: 'GB' },
    });
    const context = await prisma.browserContext.create({ data: { userId } });
    const row = await prisma.browserSession.create({
      data: {
        sessionId,
        agentId,
        contextId: context.id,
        provider: 'tilion',
        wsUrl: 'wss://back.tilion.dev/v1/session/x/cdp?token=t',
        debugUrl: 'https://back.tilion.dev/v1/session/x/live-view?token=v',
      },
    });

    const prepared = await prepareSessionCredentials(
      sessionId,
      userId,
      `https://www.${REALM}/login`
    );
    assert.equal(prepared.cookies_injected, false);
    assert.ok('worker_apply' in prepared && prepared.worker_apply !== undefined);
    assert.equal(prepared.worker_apply.cookies.length, 1);

    const injected = await injectLocalStorage(sessionId, `https://www.${REALM}`);
    assert.equal(injected.injected, false);
    assert.equal(injected.reason, WORKER_APPLY_REASON);
    assert.ok('worker_apply' in injected);
    const after = await prisma.browserSession.findUniqueOrThrow({ where: { sessionId } });
    assert.equal(after.injectedOrigins, null, 'nothing was injected, so nothing is recorded');

    // Task info: Tilion's exit is localised to the agent's proxy country, not New York.
    const info = await getTaskInfo(row.id);
    assert.equal(info?.exit_geo_locale?.timezone, 'Europe/London');
    assert.equal(info?.exit_geo_locale?.locale, 'en-GB');
    assert.equal(cdpConnects, 0, 'no backend CDP connection to a Tilion session');
  } finally {
    chromium.connectOverCDP = connect;
    await cleanup(userId, agentId);
  }
}

run()
  .then(async () => {
    await prisma.$disconnect();
    process.stdout.write('PASS browser-session tilion worker_apply unit (3 cases)\n');
  })
  .catch(async (error) => {
    process.stderr.write(`FAIL browser-session tilion worker_apply unit ${String(error)}\n`);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
