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
import { prisma } from '../../providers/database';
import * as browser from '../../providers/browser';
import * as authOptions from '../../providers/authOptions';
import { persistBrowserSessionRow } from '../../providers/browser/sessionPersist';
import { logicalBrowserTaskId } from '../../providers/browser/logicalSession';
import { EMPTY_BROWSER_BASELINE } from '../../providers/browser/checkpoint';

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
  const userId = `logical-first-init-${randomUUID()}`;
  const agentId = randomUUID();
  const resumedAgentId = randomUUID();
  const neutralAgentId = randomUUID();
  await prisma.user.create({ data: { userId, isAnonymous: false } });
  await prisma.agent.createMany({
    data: [agentId, resumedAgentId, neutralAgentId].map((id) => ({ id, userId, goal: 'logical first init' })),
  });
  await mock.module('../../providers/authOptions', {
    namedExports: {
      ...authOptions,
      getAuthOptions: async (_user: string, realm: string) => {
        authRequests.push(realm);
        return ({
        realm,
        steel_session: null,
        cookie_bundles: [],
        passwords: [],
        passkeys: [],
        email_otp: { available: false, connected_emails: [], match_for_site_account: null },
        readable_identifiers: [],
        minted: null,
      });
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
        const sessionId = `kernel-${randomUUID()}`;
        created.push({ taskId: options.taskId, sessionId });
        const row = await persistBrowserSessionRow({
          contextId,
          agentId: agentForSession,
          sessionId,
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
      closeSession: async (sessionId: string) => {
        closed.push(sessionId);
        await prisma.browserSession.updateMany({ where: { sessionId }, data: { status: 'CLOSED' } });
      },
      getFingerprintInjectionData: async () => null,
      injectUserData: async (sessionId: string, _user: string, url: string) => {
        injected.push({ sessionId, url });
        return savedSessionInjection;
      },
    },
  });
  const { initSession, prepareSessionCredentials } =
    await import('../../domains/browser-session/service');
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
    for (const target of ['about:blank', 'data:text/plain,hello', 'file:///tmp/example', 'javascript:alert(1)']) {
      await assert.rejects(prepareSessionCredentials(blank.session_id, userId, target), /authentication realm/);
    }
    const navigated = await prepareSessionCredentials(blank.session_id, userId, START_URL);
    assert.equal(navigated.auth_realm, 'example.test');
    assert.equal(navigated.cookies_injected, true);
    assert.equal(authRequests.length, authBefore + 1);
    assert.deepEqual(injected.slice(injectionsBefore), [{ sessionId: blank.session_id, url: START_URL }]);
    assert.equal(created.length, 2, 'JIT credential preparation allocated another browser');
    assert.equal(closed.length, closesBefore);

    console.log(
      'PASS logical first init: provider profile + saved credentials + full metadata; checkpointed logical resume unchanged'
    );
  } finally {
    await prisma.browserContext.deleteMany({ where: { userId } });
    await prisma.agent.deleteMany({ where: { id: { in: [agentId, resumedAgentId, neutralAgentId] } } });
    await prisma.user.delete({ where: { userId } });
    await prisma.$disconnect();
    globalThis.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
