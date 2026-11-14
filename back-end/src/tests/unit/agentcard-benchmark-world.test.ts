import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { provisionBenchmarkWorldIdentity } from '../../providers/agentcard/benchmark-world';
import { saveV2ConnectedUserId } from '../../providers/agentcard/store';

const env: NodeJS.ProcessEnv = {
  BENCHMARK_MODE: 'true',
  BENCHMARK_ISOLATED_RUN: 'true',
  BENCHMARK_AGENTCARD_WORLD_IDENTITY: 'true',
  BENCHMARK_RUN_ID: 'world-a',
  DATABASE_URL: 'postgresql://ignored@127.0.0.1:5432/owned_world_a',
  AGENTCARD_ORG_OAUTH_CLIENT_ID: 'client_fixture',
  NODE_ENV: 'test',
};
function fixture() {
  const state = new Map<string, unknown>();
  const tails = new Map<string, Promise<unknown>>();
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const attempts = new Map<string, string>();
  let fail = '';
  let failCount = 0;
  const deps = {
    now: () => Date.parse('2026-11-09T20:00:00Z'),
    read: async (key: string) => structuredClone(state.get(key)) as never,
    write: async (key: string, value: unknown) => {
      state.set(key, structuredClone(value));
    },
    lock: async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
      const previous = tails.get(key) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(fn);
      tails.set(key, next);
      try {
        return await next;
      } finally {
        if (tails.get(key) === next) tails.delete(key);
      }
    },
    request: async (
      method: string,
      path: string,
      body?: Record<string, unknown>
    ): Promise<Record<string, unknown>> => {
      calls.push({ method, path, body });
      if (path === '/api/v2/company_wallet')
        return { livemode: false, default_funds_source: 'company_flow' };
      if (path.startsWith('/api/v2/kyc?')) return { status: 'requires_verification' };
      assert.equal(method, 'POST');
      assert.ok(
        ['/api/v2/connect/start', '/api/v2/connect/verify', '/api/v2/connect/consent'].includes(
          path
        ),
        'no financial endpoints allowed'
      );
      if (path === fail && failCount++ === 0) throw new Error('response lost');
      if (path === '/api/v2/connect/start') {
        const email = String(body?.email);
        assert.match(email, /^ac-world-[a-f0-9]{40}@agentcard-benchmark\.invalid$/);
        const suffix = createHash('sha256').update(email).digest('hex').slice(0, 16);
        attempts.set('ca_' + suffix, 'usr_' + suffix);
        return { id: 'ca_' + suffix, expires_at: '2026-11-09T20:10:00Z' };
      }
      if (path === '/api/v2/connect/verify') {
        assert.equal(body?.code, '111111');
        return {
          user: { id: attempts.get(String(body?.connect_id)) },
          access_token: 'DO_NOT_PERSIST',
          refresh_token: 'DO_NOT_PERSIST',
        };
      }
      return { object: 'consent' };
    },
  };
  return {
    deps,
    state,
    calls,
    setFailure: (path: string) => {
      fail = path;
      failCount = 0;
    },
  };
}
async function main() {
  globalThis.fetch = async () => {
    throw new Error('REAL_NETWORK_FORBIDDEN');
  };
  for (const patch of [
    { NODE_ENV: 'production' },
    { RENDER: 'true' },
    { BENCHMARK_MODE: '' },
    { BENCHMARK_ISOLATED_RUN: 'false' },
    { BENCHMARK_AGENTCARD_WORLD_IDENTITY: '' },
    { DATABASE_URL: 'postgresql://ignored@remote.invalid/db' },
    { BENCHMARK_RUN_ID: '' },
  ]) {
    const f = fixture();
    await assert.rejects(() => provisionBenchmarkWorldIdentity({ ...env, ...patch }, f.deps));
    assert.equal(f.calls.length, 0);
  }
  for (const wallet of [
    { livemode: true, default_funds_source: 'company_flow' },
    { default_funds_source: 'company_flow' },
    { livemode: false, default_funds_source: 'onramp' },
  ]) {
    const f = fixture();
    f.deps.request = async (method, path) => {
      f.calls.push({ method, path });
      return wallet;
    };
    await assert.rejects(() => provisionBenchmarkWorldIdentity(env, f.deps));
    assert.deepEqual(f.calls, [{ method: 'GET', path: '/api/v2/company_wallet' }]);
  }
  const issuedAt = Date.parse('2026-11-09T20:00:00Z');
  const omitted = fixture();
  let omittedNow = issuedAt;
  omitted.deps.now = () => omittedNow;
  const omittedRequest = omitted.deps.request;
  omitted.deps.request = async (method, path, body) => {
    const result = await omittedRequest(method, path, body);
    if (path === '/api/v2/connect/start') {
      delete result.expires_at;
      omittedNow += 60_000;
    }
    return result;
  };
  await provisionBenchmarkWorldIdentity(env, omitted.deps);
  assert.equal(
    Date.parse((Array.from(omitted.state.values())[0] as { expiresAt: string }).expiresAt),
    issuedAt + 600_000
  );
  for (const expiry of [null, 'malformed', 'January 1, 2099', '2026-11-09T20:00:00Z']) {
    const invalid = fixture();
    const request = invalid.deps.request;
    invalid.deps.request = async (method, path, body) => {
      const result = await request(method, path, body);
      if (path === '/api/v2/connect/start') result.expires_at = expiry;
      return result;
    };
    await assert.rejects(() => provisionBenchmarkWorldIdentity(env, invalid.deps));
    assert.equal(invalid.calls.filter((call) => call.path === '/api/v2/connect/verify').length, 0);
  }
  const longer = fixture();
  const longerRequest = longer.deps.request;
  longer.deps.request = async (method, path, body) => {
    const result = await longerRequest(method, path, body);
    if (path === '/api/v2/connect/start') result.expires_at = '2026-11-09T20:20:00Z';
    return result;
  };
  await provisionBenchmarkWorldIdentity(env, longer.deps);
  assert.equal(
    Date.parse((Array.from(longer.state.values())[0] as { expiresAt: string }).expiresAt),
    issuedAt + 600_000
  );
  const slow = fixture();
  let slowNow = issuedAt;
  slow.deps.now = () => slowNow;
  const slowRequest = slow.deps.request;
  slow.deps.request = async (method, path, body) => {
    const result = await slowRequest(method, path, body);
    if (path === '/api/v2/connect/start') {
      delete result.expires_at;
      slowNow += 600_000;
    }
    return result;
  };
  await assert.rejects(() => provisionBenchmarkWorldIdentity(env, slow.deps), /expired/);
  assert.equal(slow.calls.filter((call) => call.path === '/api/v2/connect/verify').length, 0);
  const f = fixture();
  const [a, again] = await Promise.all([
    provisionBenchmarkWorldIdentity(env, f.deps),
    provisionBenchmarkWorldIdentity(env, f.deps),
  ]);
  assert.deepEqual(a, again);
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 3);
  assert.equal(JSON.stringify([...f.state]).includes('DO_NOT_PERSIST'), false);
  const b = await provisionBenchmarkWorldIdentity(
    {
      ...env,
      BENCHMARK_RUN_ID: 'world-b',
      DATABASE_URL: 'postgresql://ignored@localhost/owned_world_b',
    },
    f.deps
  );
  assert.notEqual(a.providerUserId, b.providerUserId);
  assert.notEqual(a.scope, b.scope);
  const previousClient = process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID;
  process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = 'unit_world_binding_client';
  try {
    let merged: Record<string, unknown> = {};
    await saveV2ConnectedUserId('owned-rose-user', a.providerUserId, {
      bindV2UserExclusively: async (_rose, _provider, merge) => {
        merged = merge({
          accessToken: 'legacy-cleanup-retained',
          v2Bindings: { other_client: 'usr_prior' },
        }) as Record<string, unknown>;
        return {};
      },
    });
    assert.equal(merged.accessToken, 'legacy-cleanup-retained');
    assert.deepEqual(merged.v2Bindings, {
      other_client: 'usr_prior',
      unit_world_binding_client: a.providerUserId,
    });
    await assert.rejects(
      () =>
        saveV2ConnectedUserId('owned-rose-user', a.providerUserId, {
          bindV2UserExclusively: async (_rose, _provider, merge) => {
            merge({ v2Bindings: { unit_world_binding_client: 'usr_existing_real_owner' } });
            return {};
          },
        }),
      /already bound/
    );
  } finally {
    if (previousClient === undefined) delete process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID;
    else process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID = previousClient;
  }
  const consent = fixture();
  consent.setFailure('/api/v2/connect/consent');
  await assert.rejects(() => provisionBenchmarkWorldIdentity(env, consent.deps));
  await provisionBenchmarkWorldIdentity(env, consent.deps);
  assert.equal(consent.calls.filter((c) => c.path === '/api/v2/connect/verify').length, 1);
  assert.equal(consent.calls.filter((c) => c.path === '/api/v2/connect/consent').length, 2);
  for (const path of ['/api/v2/connect/start', '/api/v2/connect/verify']) {
    const ambiguous = fixture();
    ambiguous.setFailure(path);
    await assert.rejects(() => provisionBenchmarkWorldIdentity(env, ambiguous.deps));
    const before = ambiguous.calls.filter((c) => c.method === 'POST').length;
    await assert.rejects(() => provisionBenchmarkWorldIdentity(env, ambiguous.deps), /ambiguous/);
    assert.equal(ambiguous.calls.filter((c) => c.method === 'POST').length, before);
  }
  process.stdout.write(
    'PASS sandbox world guards, distinct contacts, same-world concurrency/retry, token discard, consent retry and ambiguous unkeyed no-replay; no network/financial calls'
  );
}
main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
  process.exitCode = 1;
});
