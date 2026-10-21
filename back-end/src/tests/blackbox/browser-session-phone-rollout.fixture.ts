import { phoneFixtureNumber } from './phone-fixture-users';
/** Real init/resume assemblers with real local Prisma; provider IO replaced only. */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import * as browser from '../../providers/browser';
import * as authOptions from '../../providers/authOptions';
const originalFetch = globalThis.fetch;
const externalAttempts: string[] = [];
globalThis.fetch = (async (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  );
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    externalAttempts.push(url.hostname);
    throw new Error('External network forbidden in phone rollout fixture');
  }
  return originalFetch(input, init);
}) as typeof fetch;
async function main() {
  const userId = `rollout-browser-${randomUUID()}`;
  const agentId = randomUUID();
  await prisma.user.create({ data: { userId, phone: phoneFixtureNumber(), isAnonymous: false } });
  await prisma.agent.create({ data: { id: agentId, userId, goal: 'Phone rollout fixture' } });
  const context = await prisma.browserContext.create({ data: { userId, contextId: randomUUID() } });
  const session = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId,
      sessionId: randomUUID(),
      startUrl: 'https://example.com',
    },
  });
  const providerResult = {
    taskId: session.id,
    sessionId: session.sessionId,
    debugUrl: null,
    wsUrl: null,
    provider: 'steel',
    profileId: context.contextId,
    profileSource: 'existing',
    proxySource: 'none',
    savedUrl: '',
    proxyLocation: null,
  };
  const injection = {
    cookies: { injected: false, cookieCount: 0, authSource: 'none', credentialRef: null },
    fingerprint: { injected: false },
    localStorage: { originCount: 0 },
    indexedDB: { originCount: 0 },
    permissions: { grantCount: 0 },
    cacheStorage: { originCount: 0 },
  };
  await mock.module('../../providers/authOptions', {
    namedExports: {
      ...authOptions,
      getAuthOptions: async () => ({
        realm: 'example.com',
        steel_session: null,
        cookie_bundles: [],
        passwords: [],
        passkeys: [],
        email_otp: { available: false, connected_emails: [], match_for_site_account: null },
        readable_identifiers: [],
        minted: null,
      }),
    },
  });
  await mock.module('../../providers/browser', {
    namedExports: {
      ...browser,
      getOrCreateContext: async () => context.contextId,
      createSessionWithContext: async () => providerResult,
      resumeSession: async () => providerResult,
      getFingerprintInjectionData: async () => null,
      injectUserData: async () => injection,
    },
  });
  const { initSession } = await import('../../domains/browser-session/service');
  const { resumeBrowserSession } = await import('../../providers/browserSessionResume');
  const previous = process.env.CLOUD_IPHONE_ENABLED;
  try {
    const snapshot = async () => ({
      init: (await initSession(userId, agentId, 'https://example.com')).user_settings,
      resume: (await resumeBrowserSession(session.id)).user_settings,
    });
    delete process.env.CLOUD_IPHONE_ENABLED;
    const off = await snapshot();
    for (const value of Object.values(off)) {
      assert.equal(Object.hasOwn(value!, 'iphoneCapability'), false);
      assert.equal(Object.hasOwn(value!, 'userId'), false);
      assert.equal(Object.hasOwn(value!, 'isAnonymous'), false);
    }
    process.env.CLOUD_IPHONE_ENABLED = '1';
    const on = await snapshot();
    for (const key of ['init', 'resume'] as const) {
      assert.deepEqual(on[key]?.iphoneCapability, { enabled: true });
      const rest = { ...on[key]! };
      delete rest.iphoneCapability;
      assert.deepEqual(rest, off[key], 'Existing response bytes changed beyond marker');
    }
    await prisma.user.update({ where: { userId }, data: { phone: '+15555550123' } });
    const ineligible = await snapshot();
    process.env.CLOUD_IPHONE_ENABLED = '0';
    assert.deepEqual(await snapshot(), ineligible, 'Ineligible browser payload changed');
    assert.deepEqual(externalAttempts, [], 'Fixture attempted external provider traffic');
    console.log(
      'PASS real init/resume optional rollout metadata; off/ineligible payload equality; no external traffic'
    );
  } finally {
    if (previous === undefined) delete process.env.CLOUD_IPHONE_ENABLED;
    else process.env.CLOUD_IPHONE_ENABLED = previous;
    await prisma.browserContext.delete({ where: { id: context.id } });
    await prisma.agent.delete({ where: { id: agentId } });
    await prisma.user.delete({ where: { userId } });
    await prisma.$disconnect();
    globalThis.fetch = originalFetch;
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
