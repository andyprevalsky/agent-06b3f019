/**
 * Real initSession/prepareSessionCredentials with real local Prisma and the real
 * session-row persistence; only provider create/resume/injection IO is replaced.
 *
 * Regression (attempt-3 /benchmark full, 2026-10-22): an agent's first browser was
 * a never-materialized logical row, so init took the resume path. That path omits
 * the provider profile and skips saved realm credentials, and its metadata lacks
 * the injection fields. browser-auth-existing-browser-session therefore signed in
 * by password, stale-session-password never presented the expired session, and
 * webdecoy's isolation metadata was never observed.
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prisma } from '../../providers/database';
import * as browser from '../../providers/browser';
import * as authOptions from '../../providers/authOptions';
import { persistBrowserSessionRow } from '../../providers/browser/sessionPersist';
import { logicalBrowserTaskId } from '../../providers/browser/logicalSession';
import * as checkpoint from '../../providers/browser/checkpoint';
const { EMPTY_BROWSER_BASELINE } = checkpoint;

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  );
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error(`External network forbidden in logical first-init fixture: ${url.hostname}`);
  }
  return originalFetch(input, init);
}) as typeof fetch;

const START_URL = 'https://shop.example.test/account';
const created: Array<{ taskId: string | undefined; sessionId: string }> = [];
const resumed: string[] = [];
const closed: string[] = [];
const authRequests: string[] = [];
const injected: Array<{ sessionId: string; url: string }> = [];
let liveProvider = 'steel';
let ttlMs = 13 * 60_000;
let onHealth: (() => Promise<void>) | undefined;
let onInject: (() => Promise<void>) | undefined;
let createRejection: Error | undefined;
let onCommit: ((operationKey?: string) => Promise<void>) | undefined;
let failClose = false;
const originalEffectUpdate = prisma.toolSideEffect.updateMany.bind(prisma.toolSideEffect);
prisma.toolSideEffect.updateMany = (async (args) => {
  const result = await originalEffectUpdate(args);
  if (args?.data.status === 'SUCCEEDED') await onCommit?.(String(args.where?.operationKey));
  return result;
}) as typeof prisma.toolSideEffect.updateMany;
const originalTransaction = prisma.$transaction.bind(prisma);
prisma.$transaction = (async (...args: unknown[]) => {
  const result: unknown = await Reflect.apply(originalTransaction, prisma, args);
  await onCommit?.();
  return result;
}) as typeof prisma.$transaction;
const savedSessionInjection = {
  cookies: {
    injected: true,
    cookieCount: 2,
    authSource: 'saved_session',
    credentialRef: { kind: 'cookie_bundle', id: 'fixture-bundle' },
  },
  fingerprint: { injected: false },
  localStorage: { injected: false, originCount: 0 },
  indexedDB: { injected: false, originCount: 0 },
  permissions: { injected: false, grantCount: 0 },
  cacheStorage: { injected: false, originCount: 0 },
};

async function main() {
  const joining = process.argv[2] === '--join';
  const userId = joining ? process.argv[3]! : `logical-first-init-${randomUUID()}`;
  const agentId = joining ? process.argv[4]! : randomUUID();
  const resumedAgentId = randomUUID();
  const neutralAgentId = randomUUID();
  if (!joining) {
    await prisma.user.create({ data: { userId, isAnonymous: false } });
    await prisma.agent.createMany({
      data: [agentId, resumedAgentId, neutralAgentId].map((id) => ({
        id,
        userId,
        goal: 'logical first init',
      })),
    });
  }
  await mock.module('../../providers/browser/checkpoint', {
    namedExports: {
      ...checkpoint,
      checkpointLogicalBrowser: async () => {
        throw new Error('fixture: cold path captures live native state');
      },
    },
  });
  await mock.module('../../providers/authOptions', {
    namedExports: {
      ...authOptions,
      getAuthOptions: async (_user: string, realm: string) => {
        authRequests.push(realm);
        return {
          realm,
          steel_session: null,
          cookie_bundles: [],
          passwords: [],
          passkeys: [],
          email_otp: { available: false, connected_emails: [], match_for_site_account: null },
          readable_identifiers: [],
          minted: null,
        };
      },
    },
  });
  await mock.module('../../providers/browser', {
    namedExports: {
      ...browser,
      createSessionWithContext: async (
        contextId: string,
        agentForSession: string,
        _proxy: unknown,
        startUrl: string,
        options: { taskId?: string } = {}
      ) => {
        assert(!joining, 'a joining process must not allocate another provider session');
        if (createRejection !== undefined) {
          const error = createRejection;
          createRejection = undefined;
          throw error;
        }
        const sessionId = `kernel-${randomUUID()}`;
        created.push({ taskId: options.taskId, sessionId });
        const row = await persistBrowserSessionRow({
          contextId,
          agentId: agentForSession,
          sessionId,
          wsUrl: 'wss://ws.example.test',
          debugUrl: 'https://debug.example.test',
          startUrl,
          provider: 'kernel',
          taskId: options.taskId,
          providerProfileId: `profile-${agentForSession}`,
          providerProfileSource: 'new_user_persistent',
          kernelProxySource: 'none',
        });
        return {
          provider: 'kernel',
          taskId: row.id,
          sessionId,
          debugUrl: 'https://debug.example.test',
          wsUrl: 'wss://ws.example.test',
          proxySource: 'none',
          proxyLocation: { country: 'US' },
          profileId: `profile-${agentForSession}`,
          profileSource: 'new_user_persistent',
          validationBrowser: null,
        };
      },
      resumeSession: async (taskId: string) => {
        resumed.push(taskId);
        throw new Error('fixture: resume reached the provider');
      },
      getFingerprintInjectionData: async () => null,
      closeSession: async (sessionId: string) => {
        closed.push(sessionId);
        if (failClose) throw new Error('fixture close failed');
        await prisma.browserSession.updateMany({
          where: { sessionId },
          data: { status: 'CLOSED' },
        });
        return { worldState: null };
      },
      getBrowserSessionHealth: async (sessionId: string) => {
        await onHealth?.();
        return {
          provider: liveProvider,
          sessionId,
          status: 'live',
          createdAt: new Date().toISOString(),
          timeoutMs: 35 * 60_000,
          expiresAt: new Date(Date.now() + ttlMs).toISOString(),
          ttlMs,
          profileId: null,
        };
      },
      injectUserData: async (sessionId: string, _user: string, url: string) => {
        injected.push({ sessionId, url });
        await onInject?.();
        return savedSessionInjection;
      },
    },
  });
  const { initSession, prepareSessionCredentials, getTaskInfo } =
    await import('../../domains/browser-session/service');
  const { resumeOwnedBrowserSession } =
    await import('../../domains/browser-session/service.control');
  if (joining) {
    console.log('JOIN_STARTED');
    try {
      if (process.argv[5] === 'failure') {
        await assert.rejects(initSession(userId, agentId, START_URL), /before readiness/);
        console.log('JOINED_FAILED');
      } else {
        const result = await initSession(userId, agentId, START_URL);
        console.log(`JOINED_SESSION=${result.session_id}`);
      }
    } finally {
      await prisma.$disconnect();
    }
    return;
  }
  try {
    // 1. An agent's first browser (empty Home baseline, never materialized) is a
    //    new browser: provider create with a profile, saved realm credentials, and
    //    complete session metadata, all bound to the agent's logical row.
    let firstError: unknown = null;
    const first = await initSession(userId, agentId, START_URL).catch((error: unknown) => {
      firstError = error;
      return null;
    });
    const logicalId = logicalBrowserTaskId(agentId);
    assert.deepEqual(
      { created: created.map((c) => c.taskId), resumed },
      { created: [logicalId], resumed: [] },
      `first logical browser must initialize, not resume (error: ${String(firstError)})`
    );
    assert.ok(first, `initSession failed: ${String(firstError)}`);
    assert.equal(first.task_id, logicalId);
    assert.deepEqual(injected, [{ sessionId: created[0]!.sessionId, url: START_URL }]);
    assert.equal(first.auth_source, 'saved_session');
    assert.equal(first.cookies_injected, true);
    assert.deepEqual(
      {
        profile_source: first.browser_session_metadata.profile_source,
        auth_source: first.browser_session_metadata.auth_source,
        cookies_injected: first.browser_session_metadata.cookies_injected,
        cookies_count: first.browser_session_metadata.cookies_count,
        local_storage_origin_count: first.browser_session_metadata.local_storage_origin_count,
      },
      {
        profile_source: 'new_user_persistent',
        auth_source: 'saved_session',
        cookies_injected: true,
        cookies_count: 2,
        local_storage_origin_count: 0,
      }
    );
    const row = await prisma.browserSession.findUniqueOrThrow({ where: { id: logicalId } });
    assert.deepEqual(
      {
        owner: row.logicalOwnerKey,
        sessionId: row.sessionId,
        status: row.status,
        baseline: row.baselineCheckpointRef,
      },
      {
        owner: `agent:${agentId}`,
        sessionId: created[0]!.sessionId,
        status: 'ACTIVE',
        baseline: EMPTY_BROWSER_BASELINE,
      }
    );
    assert.equal(
      await prisma.browserSession.count({ where: { agentId } }),
      1,
      'first init must not allocate a second row beside the logical owner'
    );

    // A follow-up browser task must reattach its live logical browser. This is
    // the production state after a checkout approval was rejected with feedback:
    // ACTIVE Steel binding, no private checkpoint, and thirteen minutes left.
    // Recreating it would enter the unsupported Steel hydration path and discard
    // live cart/tab state even though no restoration is necessary.
    for (const provider of ['steel', 'kernel', 'browser-use']) {
      liveProvider = provider;
      await prisma.browserSession.update({
        where: { id: logicalId },
        data: {
          provider,
          wsUrl: 'wss://ws.example.test',
          debugUrl: 'https://debug.example.test',
          currentUrl: `${START_URL}/checkout`,
        },
      });
      const createCount = created.length;
      const resumeCount = resumed.length;
      const injectionCount = injected.length;
      const continued = await initSession(userId, agentId, START_URL).catch((error: unknown) => {
        throw new Error(`live ${provider} logical browser must reattach: ${String(error)}`);
      });
      assert.equal(continued.session_id, row.sessionId, 'keep the existing native session');
      assert.equal(continued.task_id, logicalId, 'keep the logical owner');
      assert.equal(created.length, createCount, 'reattach must not allocate a provider browser');
      assert.equal(resumed.length, resumeCount, 'reattach must not reconstruct the browser');
      assert.equal(injected.length, injectionCount, 'reattach must not overwrite live state');
    }
    liveProvider = 'steel';
    await prisma.browserSession.update({
      where: { id: logicalId },
      data: { provider: 'steel', checkpointRef: 'fixture-private-checkpoint' },
    });
    const warmPrivate = await initSession(userId, agentId, START_URL);
    assert.equal(warmPrivate.session_id, row.sessionId, 'warm private state needs no hydration');

    // Acquiring user control or replacing the binding while provider health is
    // in flight must prevent the old browser from being handed to the agent.
    onHealth = async () => {
      await prisma.browserSession.update({
        where: { id: logicalId },
        data: { controlState: 'USER', controlLeaseExpiresAt: new Date(Date.now() + 60_000) },
      });
    };
    await assert.rejects(initSession(userId, agentId, START_URL), /under user control/);
    onHealth = async () => {
      await prisma.browserSession.update({
        where: { id: logicalId },
        data: { sessionId: `replaced-${randomUUID()}` },
      });
    };
    await prisma.browserSession.update({
      where: { id: logicalId },
      data: { controlState: 'AGENT', controlLeaseExpiresAt: null },
    });
    await assert.rejects(initSession(userId, agentId, START_URL), /binding changed/);
    onHealth = undefined;
    ttlMs = 0;
    await assert.rejects(
      initSession(userId, agentId, START_URL),
      /cold path captures live native state/,
      'expiring warm execution must capture current native state before cold allocation'
    );
    ttlMs = 13 * 60_000;
    console.log('PASS live logical browser reattachment preserves native binding and state');

    // 2. A logical browser that already holds private checkpoint state keeps the
    //    resume contract: no fresh create, and no shared-store credential injection.
    const { ensureLogicalBrowser } = await import('../../providers/browser/logicalSession');
    const owned = await ensureLogicalBrowser(userId, resumedAgentId);
    const privateSession = `kernel-${randomUUID()}`;
    await prisma.browserSession.update({
      where: { id: owned.id },
      data: { sessionId: privateSession, checkpointRef: 'fixture-private-checkpoint' },
    });
    // Its resume continues through the provider custody path (not exercised here);
    // the contract under test is only that init never re-creates it.
    await initSession(userId, resumedAgentId, START_URL).catch(() => null);
    assert.equal(created.length, 1, 'a checkpointed logical browser must not re-initialize');
    injected.length = 0;
    const prepared = await prepareSessionCredentials(privateSession, userId, START_URL);
    assert.deepEqual(injected, [], 'private checkpoint state must not take shared-store injection');
    assert.equal(prepared.cookies_injected, false);
    // 3. Exact about:blank is a neutral initial page, not an auth realm.
    // Materialize the real logical row once without reading/injecting credentials.
    const authBefore = authRequests.length;
    const injectionsBefore = injected.length;
    const closesBefore = closed.length;
    const blank = await initSession(userId, neutralAgentId, 'about:blank');
    assert.equal(blank.auth_realm, '');
    assert.equal(blank.auth_options.realm, '');
    assert.deepEqual(blank.auth_options.cookie_bundles, []);
    assert.deepEqual(blank.auth_options.passwords, []);
    assert.deepEqual(blank.auth_options.passkeys, []);
    assert.deepEqual(blank.passwords, []);
    assert.deepEqual(blank.passkeys, []);
    assert.equal(blank.cookies_injected, false);
    assert.equal(blank.auth_source, 'none');
    assert.equal(blank.browser_session_metadata.cookies_count, 0);
    assert.equal(blank.browser_session_metadata.local_storage_origin_count, 0);
    assert.equal(authRequests.length, authBefore, 'blank initialization queried an auth realm');
    assert.equal(injected.length, injectionsBefore, 'blank initialization injected origin data');
    assert.equal(closed.length, closesBefore, 'blank initialization retired its logical browser');
    const neutralId = logicalBrowserTaskId(neutralAgentId);
    const neutral = await prisma.browserSession.findUniqueOrThrow({ where: { id: neutralId } });
    assert.equal(neutral.status, 'ACTIVE');
    assert.equal(neutral.sessionId, blank.session_id);
    assert.equal(await prisma.browserSession.count({ where: { agentId: neutralAgentId } }), 1);
    assert.equal(created.length, 2);

    // Credential preparation remains realm-only. Once navigation selects HTTPS,
    // the existing JIT path injects the real target without allocating again.
    for (const target of [
      'about:blank',
      'data:text/plain,hello',
      'file:///tmp/example',
      'javascript:alert(1)',
    ]) {
      await assert.rejects(
        prepareSessionCredentials(blank.session_id, userId, target),
        /authentication realm/
      );
    }
    const navigated = await prepareSessionCredentials(blank.session_id, userId, START_URL);
    assert.equal(navigated.auth_realm, 'example.test');
    assert.equal(navigated.cookies_injected, true);
    assert.equal(authRequests.length, authBefore + 1);
    assert.deepEqual(injected.slice(injectionsBefore), [
      { sessionId: blank.session_id, url: START_URL },
    ]);
    assert.equal(created.length, 2, 'JIT credential preparation allocated another browser');
    assert.equal(closed.length, closesBefore);

    console.log(
      'PASS logical first init: provider profile + saved credentials + full metadata; checkpointed logical resume unchanged'
    );

    const premature: string[] = [];
    const additionalFailures: string[] = [];
    for (const failPreparation of [false, true]) {
      const concurrentAgentId = randomUUID();
      await prisma.agent.create({
        data: { id: concurrentAgentId, userId, goal: 'concurrent init' },
      });
      let entered!: () => void;
      let finish!: () => void;
      const preparing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      onInject = async () => {
        entered();
        await gate;
        if (failPreparation) throw new Error('fixture preparation failed');
      };
      const capture = <T>(promise: Promise<T>) =>
        promise.then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error })
        );
      const firstPending = capture(initSession(userId, concurrentAgentId, START_URL));
      await preparing;
      const taskId = logicalBrowserTaskId(concurrentAgentId);
      const pendingInfo = await getTaskInfo(taskId, { validateLive: true });
      if (pendingInfo?.same_session_available === true)
        additionalFailures.push('pending task-info advertised readiness');
      if (pendingInfo?.status === 'ACTIVE')
        additionalFailures.push('unprepared binding published ACTIVE');
      const resumeCount = resumed.length;
      await resumeOwnedBrowserSession(taskId, userId).catch(() => undefined);
      if (resumed.length !== resumeCount)
        additionalFailures.push('pending preparation permitted replacement');
      failClose = failPreparation;
      const child = spawn(process.execPath, [
        '--experimental-test-module-mocks',
        '--import',
        'tsx',
        fileURLToPath(import.meta.url),
        '--join',
        userId,
        concurrentAgentId,
        failPreparation ? 'failure' : 'success',
      ]);
      let childOutput = '';
      let childStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        childStarted = resolve;
      });
      child.stdout.on('data', (chunk) => {
        childOutput += String(chunk);
        if (childOutput.includes('JOIN_STARTED')) childStarted();
      });
      child.stderr.on('data', (chunk) => {
        childOutput += String(chunk);
      });
      const childDone = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`joining process exited ${String(code)}: ${childOutput}`));
        });
      });
      let settled = false;
      const secondPending = capture(initSession(userId, concurrentAgentId, START_URL)).then(
        (result) => {
          settled = true;
          return result;
        }
      );
      try {
        await Promise.race([
          started,
          childDone.then(() => {
            throw new Error('join never started');
          }),
        ]);
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        if (settled) premature.push(failPreparation ? 'failed preparation' : 'pending preparation');
      } finally {
        finish();
      }
      const [initial, joined] = await Promise.all([firstPending, secondPending]);
      await childDone;
      onInject = undefined;
      if (failPreparation) {
        assert(initial.error instanceof Error, 'preparation failure must reject initial init');
        if (!(joined.error instanceof Error)) premature.push('failed preparation exposed as ready');
        const failedInfo = await getTaskInfo(taskId, { validateLive: true });
        if (failedInfo?.same_session_available === true)
          additionalFailures.push('failed task-info advertised readiness');
      } else {
        assert.equal(initial.error, null);
        assert.equal(joined.error, null);
        assert.equal(initial.value?.session_id, joined.value?.session_id);
        assert(childOutput.includes(`JOINED_SESSION=${initial.value?.session_id}`));
      }
      failClose = false;
    }
    assert.deepEqual(
      premature,
      [],
      'concurrent init must join complete preparation and retain failure'
    );
    console.log(
      'PASS concurrent logical initialization joins preparation and rejects failed readiness'
    );
    for (const definite of [true, false]) {
      const retryAgentId = randomUUID();
      await prisma.agent.create({
        data: { id: retryAgentId, userId, goal: 'initial rejection retry' },
      });
      createRejection = definite
        ? new browser.BrowserProviderRateLimitError(
            'kernel',
            'fixture definite no-allocation rejection'
          )
        : new Error('fixture ambiguous allocation outcome');
      await assert.rejects(initSession(userId, retryAgentId, START_URL));
      const retried = await initSession(userId, retryAgentId, START_URL).then(
        () => true,
        () => false
      );
      if (retried !== definite)
        additionalFailures.push(
          definite ? 'definite rejection poisoned retry' : 'ambiguous allocation retried'
        );
    }
    const { runBrowserInitAdoptionCases } =
      await import('./browser-session-init-adoption.fixture-support');
    additionalFailures.push(
      ...(await runBrowserInitAdoptionCases(userId, START_URL, (hook) => {
        onCommit = hook;
      }))
    );
    assert.deepEqual(
      additionalFailures,
      [],
      'readiness, safe retry and adoption must share durable custody'
    );
    console.log(
      'PASS shared readiness, safe rejected-create retry, and allocator adoption custody'
    );
  } finally {
    prisma.toolSideEffect.updateMany = originalEffectUpdate;
    prisma.$transaction = originalTransaction;
    await prisma.toolSideEffect.deleteMany({
      where: {
        operationType: 'browser_session_initialization',
        request: { path: ['userId'], equals: userId },
      },
    });
    await prisma.toolSideEffect.deleteMany({
      where: {
        operationKey: {
          in: created.map((entry) => `steel-browser-task-lifecycle:${entry.taskId}`),
        },
      },
    });
    await prisma.browserContext.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { userId } });

    await prisma.user.delete({ where: { userId } });
    await prisma.$disconnect();
    globalThis.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
