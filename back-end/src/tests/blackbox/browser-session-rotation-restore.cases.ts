/**
 * A rotation's proxy can fail the tunnel for a restored tab. Replays
 * the captured failure through the real rotation and checkpoint restore; only the
 * provider allocation and the Playwright page are fakes. Registered by
 * browser-session-hydration-failure.cases.ts.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { prisma } from '../../providers/database';
import { writeBrowserCheckpoint } from '../../providers/browser/checkpoint';
import {
  rotateBrowserProxy,
  type BrowserSessionResumeDependencies,
} from '../../providers/browserSessionResume';

const TAB_URL = 'https://api.ipify.org/?format=json&nonce=466beac0-e6c2-40af-bae4-e61ee7af63d6';
// Captured at 07:42:11Z on 2026-11-08 (PR #1775 attempt 4): the tunnel for the restored
// tab failed on the new Steel session 584 ms after navigation started; rotation 4 returned 500.
const TUNNEL_FAILURE =
  `page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at ${TAB_URL}\n` +
  `Call log:\n  - navigating to "${TAB_URL}", waiting until "domcontentloaded"\n`;
const TIMEOUT_FAILURE = 'page.goto: Timeout 30000ms exceeded';

type GotoOutcome = string | null;

/** Each provider allocation is a new browser whose goto results follow `outcomes`. */
function fakeRotationDependencies(browsers: GotoOutcome[][]) {
  const gotos: string[][] = [];
  const replacements: string[] = [];
  const closed: string[] = [];
  const fake = {
    /** Runs inside each navigation, before its outcome. */
    onGoto: async (): Promise<unknown> => undefined,
    gotos,
    replacements,
    closed,
    dependencies: {} as BrowserSessionResumeDependencies,
  };
  fake.dependencies = {
    getBrowserCaptchaTelemetry: async () => null,
    rotateProxy: async (taskId: string, step: { provider: string }) => {
      const sessionId = `replacement-${randomUUID()}`;
      await prisma.browserSession.update({
        where: { id: taskId },
        data: {
          sessionId,
          wsUrl: `wss://${step.provider}.invalid/${sessionId}`,
          debugUrl: `https://${step.provider}.invalid/${sessionId}`,
          status: 'PAUSED',
        },
      });
      const outcomes = browsers[replacements.length] ?? [];
      const attempts: string[] = [];
      gotos.push(attempts);
      replacements.push(sessionId);
      const page = {
        url: () => 'about:blank',
        goto: async (url: string) => {
          attempts.push(url);
          await fake.onGoto();
          const failure = outcomes[attempts.length - 1] ?? null;
          if (failure !== null) throw new Error(failure);
          return null;
        },
      };
      const validationBrowser = {
        contexts: () => [{ setStorageState: async () => undefined, pages: () => [page] }],
        close: async () => {
          closed.push(sessionId);
        },
      } as unknown as Browser;
      return {
        validationBrowser,
        provider: step.provider,
        sessionId,
        debugUrl: `https://${step.provider}.invalid/${sessionId}`,
        wsUrl: `wss://${step.provider}.invalid/${sessionId}`,
        proxySource: 'kernel_residential_state',
        profileId: null,
        profileSource: 'test',
        previousProvider: 'kernel',
        recoveryAction: 'ip_rotated',
        proxyType: 'residential',
      };
    },
  } as unknown as BrowserSessionResumeDependencies;
  return fake;
}

async function seedLogicalRow() {
  const userId = `rotation-restore-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  const context = await prisma.browserContext.create({ data: { userId } });
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: userId,
      logicalOwnerKey: `agent:${userId}`,
      provider: 'kernel',
      sessionId: `previous-${randomUUID()}`,
      status: 'ACTIVE',
    },
  });
  const checkpointRef = await writeBrowserCheckpoint({
    version: 1,
    userId,
    sourceLogicalId: session.id,
    sourceRevision: 1,
    storage: { cookies: [], origins: [] },
    tabs: [{ url: TAB_URL, sessionStorage: [] }],
    limitations: ['no_external_action_replay', 'no_websocket_or_heap_state'],
  });
  await prisma.browserSession.update({
    where: { id: session.id },
    data: { checkpointRef, checkpointRevision: 1 },
  });
  const read = () => prisma.browserSession.findUniqueOrThrow({ where: { id: session.id } });
  const cleanup = async () => {
    await prisma.browserContext.delete({ where: { id: context.id } });
    await prisma.user.delete({ where: { userId } });
  };
  return { id: session.id, read, cleanup };
}

async function assertSingleTunnelFailureRetriesTheRestoredTab(): Promise<void> {
  const row = await seedLogicalRow();
  const fake = fakeRotationDependencies([[TUNNEL_FAILURE]]);
  try {
    const response = await rotateBrowserProxy(row.id, undefined, undefined, {}, fake.dependencies);
    assert.equal(response.rotations_used, 1, 'one recovery spent one rotation');
    assert.equal(response.session_id, fake.replacements[0]);
    assert.deepEqual(fake.gotos, [[TAB_URL, TAB_URL]], 'the same session reloads the saved tab');
    assert.deepEqual(fake.closed, fake.replacements, 'the validation client is released');
    const ready = await row.read();
    assert.equal(ready.status, 'ACTIVE');
    assert.equal(ready.proxyRotationCount, 1);
    process.stdout.write('PASS rotation restore: single tunnel failure recovers on the session\n');
  } finally {
    await row.cleanup();
  }
}

async function assertPersistentTunnelFailureStaysBounded(): Promise<void> {
  const row = await seedLogicalRow();
  const fake = fakeRotationDependencies([[TUNNEL_FAILURE, TUNNEL_FAILURE, TUNNEL_FAILURE]]);
  try {
    await assert.rejects(
      rotateBrowserProxy(row.id, undefined, undefined, {}, fake.dependencies),
      /ERR_TUNNEL_CONNECTION_FAILED/
    );
    assert.equal(fake.gotos[0]!.length, 3, 'tab restore on one exit is bounded');
    assert.equal((await row.read()).status, 'PAUSED', 'an unrestored browser must not go ACTIVE');
    process.stdout.write('PASS rotation restore: persistent tunnel failure stays bounded\n');
  } finally {
    await row.cleanup();
  }
}

async function assertChangedBindingStopsTheRetry(): Promise<void> {
  const row = await seedLogicalRow();
  const fake = fakeRotationDependencies([[TUNNEL_FAILURE]]);
  fake.onGoto = () =>
    prisma.browserSession.update({
      where: { id: row.id },
      data: { sessionId: `newer-${randomUUID()}` },
    });
  try {
    await assert.rejects(
      rotateBrowserProxy(row.id, undefined, undefined, {}, fake.dependencies),
      /Logical browser ownership changed/
    );
    assert.equal(fake.gotos[0]!.length, 1, 'a retry must not navigate a browser it lost');
    process.stdout.write('PASS rotation restore: changed binding stops the retry\n');
  } finally {
    await row.cleanup();
  }
}

async function assertOtherNavigationFailuresStayTerminal(): Promise<void> {
  const row = await seedLogicalRow();
  const fake = fakeRotationDependencies([[TIMEOUT_FAILURE]]);
  try {
    await assert.rejects(
      rotateBrowserProxy(row.id, undefined, undefined, {}, fake.dependencies),
      /Timeout 30000ms exceeded/
    );
    assert.equal(fake.gotos[0]!.length, 1, 'only proxy tunnel failures repeat the navigation');
    assert.equal((await row.read()).status, 'PAUSED', 'partial hydration must not publish ACTIVE');
    process.stdout.write('PASS rotation restore: other navigation failures stay terminal\n');
  } finally {
    await row.cleanup();
  }
}

export async function runRotationRestoreTunnelCases(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'rotation-restore-'));
  const names = [
    'CLAUDE_CREDENTIAL_DECRYPTION_KEY',
    'CODE_SESSION_STORAGE_BACKEND',
    'CODE_SESSION_STORAGE_LOCAL_DIR',
  ] as const;
  const previous = names.map((name) => process.env[name]);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY = Buffer.from(
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  ).toString('base64');
  process.env.CODE_SESSION_STORAGE_BACKEND = 'local';
  process.env.CODE_SESSION_STORAGE_LOCAL_DIR = directory;
  try {
    await assertSingleTunnelFailureRetriesTheRestoredTab();
    await assertPersistentTunnelFailureStaysBounded();
    await assertOtherNavigationFailuresStayTerminal();
    await assertChangedBindingStopsTheRetry();
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
    await rm(directory, { recursive: true, force: true });
  }
}
