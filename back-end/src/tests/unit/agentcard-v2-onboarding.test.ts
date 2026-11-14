import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  startV2Onboarding,
  startV2Connection,
  verifyV2Connection,
  refreshV2OnboardingStatus,
  validateV2SandboxFixtureUser,
  type V2OnboardingDependencies,
} from '../../providers/agentcard/v2-onboarding';
import { createV2Router } from '../../domains/agentcard/routes';
import { getStatus } from '../../domains/agentcard/service';
import { getV2ConnectedUserId, saveV2ConnectedUserId } from '../../providers/agentcard/store';

async function main(): Promise<void> {
  process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = 'unit_onboarding_client';
  process.env.AGENTCARD_PUBLIC_URL = 'https://rose.example';
  process.env.AGENTCARD_CONNECT_SECRET = 'unit-test-connect-secret';
  const state = new Map<string, unknown>();
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  let now = Date.now();
  let saved: string | undefined;
  let kyc = 0;
  let consentFails = true;
  let id = 0;
  const deps: V2OnboardingDependencies = {
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      if (path.endsWith('/start'))
        return { object: 'connect_attempt', id: 'ca_server', channel: 'email' };
      if (path.endsWith('/verify')) {
        if (body?.code === '000000') throw new Error('invalid_code');
        return { user: { id: 'usr_server' }, access_token: 'SECRET', refresh_token: 'SECRET' };
      }
      if (path.endsWith('/consent')) {
        if (consentFails) throw new Error('temporary consent failure');
        return {};
      }
      if (path.endsWith('/company_wallet'))
        return { livemode: true, default_funds_source: 'company_flow' };
      assert.equal(path, '/api/v2/kyc?user_id=usr_server');
      return { status: 'requires_verification', iframe_url: `https://kyc.example/${++kyc}` };
    },
    put: async (namespace, key, value) => {
      state.set(`${namespace}:${key}`, structuredClone(value));
    },
    get: async <T>(namespace: string, key: string) =>
      state.get(`${namespace}:${key}`) as T | undefined,
    lock: async (_key, fn) => fn(),
    now: () => now,
    randomId: () => `session-${++id}`,
    getConnectedUserId: async () => saved,
    saveConnectedUserId: async (_userId, providerId) => {
      saved = providerId;
    },
  };
  const session = await startV2Onboarding('rose-user', deps);
  now += 1000;
  assert.deepEqual(
    await startV2Onboarding('rose-user', deps),
    session,
    'funding retry reuses the signed setup session'
  );
  assert.equal(calls.length, 0, 'creating a setup link must never send email');
  const fixtureCalls: string[] = [];
  await validateV2SandboxFixtureUser('usr_fixture', async (method, path) => {
    assert.equal(method, 'GET', 'fixture admission must be read-only');
    fixtureCalls.push(path);
    return path.endsWith('company_wallet')
      ? { livemode: false, default_funds_source: 'company_flow' }
      : { status: 'requires_verification' };
  });
  assert.deepEqual(fixtureCalls, ['/api/v2/company_wallet', '/api/v2/kyc?user_id=usr_fixture']);
  for (const wallet of [
    { livemode: true, default_funds_source: 'company_flow' },
    { livemode: false, default_funds_source: 'onramp' },
    {},
  ]) {
    await assert.rejects(
      validateV2SandboxFixtureUser('usr_fixture', async () => wallet),
      /sandbox credentials and company funding/
    );
  }
  await assert.rejects(
    validateV2SandboxFixtureUser('ch_legacy', async () => {
      throw new Error('must reject before HTTP');
    }),
    /never a cardholderId/
  );
  const url = new URL(session.setupUrl);
  assert.equal(url.searchParams.get('user'), 'rose-user');
  await assert.rejects(
    startV2Connection('attacker', session.sessionId, { email: 'a@example.com' }, deps),
    /expired|belong/i
  );
  await assert.rejects(
    startV2Connection(
      'rose-user',
      session.sessionId,
      { email: 'a@example.com', phone: '+15551234567' },
      deps
    ),
    /exactly one/i
  );
  await startV2Connection('rose-user', session.sessionId, { email: 'a@example.com' }, deps);
  assert.deepEqual(calls[0].body, { email: 'a@example.com', external_user_id: 'rose-user' });
  await assert.rejects(
    verifyV2Connection('rose-user', session.sessionId, '000000', true, deps),
    /invalid_code/
  );
  await assert.rejects(
    verifyV2Connection('rose-user', session.sessionId, '111111', false, deps),
    /consent/i
  );
  await assert.rejects(
    verifyV2Connection('rose-user', session.sessionId, '111111', true, deps),
    /consent failure/
  );
  assert.equal(saved, undefined, 'failed consent must not make cards available');
  consentFails = false;
  await verifyV2Connection('rose-user', session.sessionId, '111111', true, deps);
  assert.equal(saved, 'usr_server');
  assert.equal(
    calls.filter((c) => c.path.endsWith('/verify')).length,
    2,
    'retry consent without replaying consumed OTP'
  );
  assert.deepEqual(calls.filter((c) => c.path.endsWith('/consent')).at(-1)?.body, {
    user_id: 'usr_server',
  });
  assert(
    !JSON.stringify([...state.values()]).includes('SECRET'),
    'connection tokens must never enter setup state'
  );
  const first = await refreshV2OnboardingStatus('rose-user', deps);
  const second = await refreshV2OnboardingStatus('rose-user', deps);
  assert.equal(first?.connected, false);
  assert.notEqual(first?.setupUrl, second?.setupUrl, 'hosted KYC URL must be read fresh');
  const status = await getStatus('rose-user', {
    refreshV2OnboardingStatus: async () => second,
    refreshOrgCardholderStatus: async () => {
      throw new Error('v2 must not call legacy MCP');
    },
    getUserToken: async () => {
      throw new Error('v2 must not read legacy user OAuth');
    },
  });
  assert.deepEqual(status, { ...second, apiVersion: 2 });
  const sandboxReads: string[] = [];
  const sandboxStatus = await refreshV2OnboardingStatus('rose-user', {
    ...deps,
    request: async (_method, path) => {
      sandboxReads.push(path);
      return path.endsWith('company_wallet')
        ? { livemode: false, default_funds_source: 'company_flow' }
        : { status: 'pending' };
    },
  });
  assert.equal(
    sandboxStatus?.connected,
    true,
    'company-funded sandbox connection skips pending KYC'
  );
  assert.equal(sandboxStatus?.livemode, false);
  assert.equal(sandboxStatus?.fundsSource, 'company_flow');
  const liveReady = await getStatus('rose-user', {
    refreshV2OnboardingStatus: () =>
      refreshV2OnboardingStatus('rose-user', {
        ...deps,
        request: async (_method, path) =>
          path.endsWith('company_wallet')
            ? { livemode: true, default_funds_source: 'company_flow' }
            : { status: 'approved' },
      }),
  });
  assert.deepEqual(liveReady, {
    connected: true,
    status: 'approved',
    apiVersion: 2,
    livemode: true,
    fundsSource: 'company_flow',
  });
  assert.deepEqual(
    sandboxReads,
    ['/api/v2/company_wallet'],
    'proven sandbox company mode must not read KYC'
  );
  for (const wallet of [
    { livemode: true, default_funds_source: 'company_flow' },
    { livemode: false, default_funds_source: 'onramp' },
    {},
  ]) {
    const livePending = await refreshV2OnboardingStatus('rose-user', {
      ...deps,
      request: async (_method, path) =>
        path.endsWith('company_wallet') ? wallet : { status: 'pending' },
    });
    assert.equal(
      livePending?.connected,
      false,
      'pending KYC is required without proven sandbox company funding'
    );
  }
  for (const kycStatus of ['approved', 'pending', 'rejected']) {
    const kycResult = await refreshV2OnboardingStatus('rose-user', {
      ...deps,
      request: async () => ({ status: kycStatus, iframe_url: 'https://stale.example' }),
    });
    assert.equal(kycResult?.connected, kycStatus === 'approved');
    assert.equal(kycResult?.setupUrl, undefined);
  }
  const phoneSession = await startV2Onboarding('phone-user', deps);
  await startV2Connection('phone-user', phoneSession.sessionId, { phone: '+15551234567' }, deps);
  assert.deepEqual(calls.at(-1)?.body, { phone: '+15551234567', external_user_id: 'phone-user' });
  await assert.rejects(
    verifyV2Connection('attacker', session.sessionId, '111111', true, deps),
    /expired|belong/i
  );

  assert.equal(
    await getV2ConnectedUserId('legacy', {
      findConnectedConfig: async () => ({ orgManaged: true, cardholderId: 'ch_legacy' }),
    }),
    undefined
  );
  let config: unknown;
  await saveV2ConnectedUserId('rose-user', 'usr_server', {
    bindV2UserExclusively: async (_user, _provider, build) => {
      config = build({ cardholderId: 'ch_legacy', accessToken: 'legacy' });
      return {};
    },
  });
  assert.deepEqual(config, {
    v2ClientId: process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID,
    v2Bindings: { [process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID!]: 'usr_server' },
    cardholderId: 'ch_legacy',
    accessToken: 'legacy',
    v2UserId: 'usr_server',
  });
  await assert.rejects(
    saveV2ConnectedUserId('other', 'usr_server', {
      bindV2UserExclusively: async () => ({ conflictingUserId: 'rose-user' }),
    }),
    /already bound/i
  );

  saved = undefined;
  const httpSession = await startV2Onboarding('http-user', deps);
  const httpUrl = new URL(httpSession.setupUrl);
  const app = express();
  app.use('/api/agentcard/v2', createV2Router(deps));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agentcard/v2`;
  try {
    const good = await fetch(`${base}/connect${httpUrl.search}`);
    assert.equal(good.status, 200);
    assert.equal(good.headers.get('cache-control'), 'no-store');
    assert((await good.text()).includes('Agentcard'));
    assert.equal(
      (await fetch(`${base}/connect?user=forged&t=bad&session=${httpSession.sessionId}`)).status,
      400
    );
    const body = new URLSearchParams(httpUrl.search);
    body.set('email', 'http@example.com');
    body.set('user_id', 'usr_attacker');
    const start = await fetch(`${base}/connect/start`, { method: 'POST', body });
    assert.equal(start.status, 200);
    body.set('code', '111111');
    body.set('consent', 'yes');
    const verify = await fetch(`${base}/connect/verify`, { method: 'POST', body });
    assert.equal(verify.status, 200);
    const html = await verify.text();
    assert(!html.includes('SECRET'));
    assert.equal(saved, 'usr_server', 'browser-supplied user_id must be ignored');
    const expired = await startV2Onboarding('expired', deps);
    now += 16 * 60 * 1000;
    await assert.rejects(
      startV2Connection('expired', expired.sessionId, { phone: '+15551234567' }, deps),
      /expired/i
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
  process.stdout.write(
    'AgentCard v2 onboarding: provider binding, consent retry, expiry, fresh KYC and loopback HTTP passed\n'
  );
}
void main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
