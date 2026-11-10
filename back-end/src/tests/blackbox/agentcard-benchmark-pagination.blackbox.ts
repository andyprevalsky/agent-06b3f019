import assert from 'node:assert/strict';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import type { AgentCardOrgToolCaller } from '../../providers/agentcard/org-runtime';

// Synthetic sandbox fixtures only. Network and stateful dependencies throw on use.
const fixtureRequire = createRequire(__filename);
const root = path.resolve(__dirname, '../../../..');
let networkCalls = 0,
  dbCalls = 0;
const denyNetwork = () => {
  networkCalls++;
  throw Error('fixture forbids network');
};
global.fetch = denyNetwork;
http.request = denyNetwork;
http.get = denyNetwork;
https.request = denyNetwork;
https.get = denyNetwork;
const inject = (file: string, exports: unknown): void => {
  const key = fixtureRequire.resolve(file);
  const fixture = new Module(key);
  fixture.filename = key;
  fixture.loaded = true;
  fixture.exports = exports;
  fixtureRequire.cache[key] = fixture;
};
const forbidden = () => {
  dbCalls++;
  throw Error('fixture forbids DB/store/wallet side effect');
};
inject(root + '/back-end/src/providers/database.ts', {
  prisma: new Proxy({}, { get: () => forbidden }),
});
inject(root + '/back-end/src/providers/agentcard/store.ts', {
  getOrgManagedCardholderId: forbidden,
  getOrgOnboardingConfig: forbidden,
  saveOrgCardholderId: forbidden,
  saveOrgOnboardingConfig: forbidden,
});
inject(root + '/back-end/src/providers/agentcard/org-wallet-monitor.ts', {
  readAgentCardOrgWallet: forbidden,
});
function fixture(total: number, changes = false) {
  const rows = Array.from({ length: total }, (_, i) => ({
    id: 'fixture-cardholder-' + String(i + 1).padStart(3, '0'),
    email: i === total - 1 ? 'agentcard-benchmark@roselabs.ai' : 'synthetic-' + i + '@invalid.test',
  }));
  const calls: { name: string; args: Record<string, unknown>; deadline: number | undefined }[] = [];
  const approvedRow = rows.at(-1),
    pendingRow = rows.at(-2);
  assert.ok(approvedRow && pendingRow);
  const approved = approvedRow.id,
    pending = pendingRow.id;
  const call: AgentCardOrgToolCaller = async (name, args, deadline) => {
    calls.push({ name, args, deadline });
    if (name === 'list_cardholders') {
      const limit = args.limit ?? 50,
        offset = args.offset ?? 0;
      assert.equal(typeof limit, 'number');
      assert.equal(typeof offset, 'number');
      assert.ok(typeof limit === 'number' && typeof offset === 'number');
      assert.ok(limit > 0 && limit <= 100);
      assert.ok(offset >= 0);
      let page = rows.slice(offset, offset + limit);
      if (changes && offset > 0 && page.length) page = [rows[0], ...page];
      return {
        structuredContent: {
          message: 'synthetic sandbox provider fixture',
          cardholders: page,
          total,
        },
      };
    }
    if (name === 'get_cardholder_kyc_status')
      return {
        structuredContent: {
          kyc_status:
            args.cardholder_id === approved
              ? 'verified'
              : args.cardholder_id === pending
                ? 'pending'
                : 'not_started',
        },
      };
    throw Error('unexpected financial tool ' + name);
  };
  return { rows, calls, approved, pending, call };
}
(async () => {
  const helper = await import('../../providers/agentcard/benchmark-float');
  let passed = 0;
  const f = fixture(92);
  const selected = await helper.resolveBenchmarkCardholderId([f.pending], f.call);
  const readiness = await helper.ensureBenchmarkOrgCardholder(selected, f.call);
  assert.equal(
    selected,
    f.approved,
    'late original benchmark candidate must be discovered after preferred pending ID'
  );
  assert.equal(readiness.verificationStatus, 'verified');
  passed++;
  const large = fixture(242);
  assert.equal(
    await helper.resolveBenchmarkCardholderId([large.pending], large.call),
    large.approved
  );
  assert.ok(large.calls.filter((x) => x.name === 'list_cardholders').length >= 3);
  passed++;
  const moving = fixture(142, true);
  assert.equal(
    await helper.resolveBenchmarkCardholderId([moving.pending], moving.call),
    moving.approved
  );
  passed++;
  const noReady = fixture(5);
  const pendingCall: AgentCardOrgToolCaller = async (name, args, deadline) =>
    name === 'get_cardholder_kyc_status'
      ? { structuredContent: { kyc_status: 'pending' } }
      : noReady.call(name, args, deadline);
  const unready = await helper.resolveBenchmarkCardholderId([noReady.pending], pendingCall);
  await assert.rejects(
    helper.ensureBenchmarkOrgCardholder(unready, pendingCall),
    /not KYC-ready \(pending\)/
  );
  passed++;
  for (const group of [f, large, moving]) {
    const deadlines = group.calls.map((x) => x.deadline).filter((x) => x !== undefined);
    assert.ok(
      new Set(deadlines).size === 1,
      'one original shared deadline across pagination and KYC'
    );
  }
  passed++;
  const early = fixture(242),
    first = early.rows[0].id;
  const earlyCall: AgentCardOrgToolCaller = async (name, args, deadline) => {
    if (name === 'list_cardholders' && typeof args.offset === 'number' && args.offset > 0)
      throw Error('unrelated later page unavailable');
    if (name === 'get_cardholder_kyc_status')
      return {
        structuredContent: { kyc_status: args.cardholder_id === first ? 'verified' : 'pending' },
      };
    return early.call(name, args, deadline);
  };
  assert.equal(await helper.resolveBenchmarkCardholderId([first], earlyCall), first);
  assert.equal(early.calls.filter((x) => x.name === 'list_cardholders').length, 1);
  passed++;
  const runtime = await import('../../providers/agentcard/org-runtime');
  const pressure = new runtime.AgentCardOrgRuntimeError(
    'synthetic typed backpressure',
    429,
    'agentcard_org_mcp_rate_limited'
  );
  const throttled = fixture(242);
  await assert.rejects(
    helper.resolveBenchmarkCardholderId([throttled.pending], async (name, args, deadline) => {
      if (name === 'list_cardholders' && typeof args.offset === 'number' && args.offset > 0)
        throw pressure;
      return throttled.call(name, args, deadline);
    }),
    (e) => e === pressure
  );
  passed++;
  await assert.rejects(
    helper.resolveBenchmarkCardholderId([], async () => ({
      structuredContent: { cardholders: [{ id: 'valid' }], total: 2.5 },
    })),
    /metadata is malformed/
  );
  passed++;
  await assert.rejects(
    helper.resolveBenchmarkCardholderId([], async (name, args) => ({
      structuredContent: {
        cardholders:
          args.offset === 0 ? Array.from({ length: 100 }, (_, i) => ({ id: 'row-' + i })) : [],
        total: 200,
      },
    })),
    /made no progress/
  );
  passed++;
  const now = Date.now;
  let clock = 100000;
  Date.now = () => clock;
  try {
    const expiring = fixture(242);
    await assert.rejects(
      helper.resolveBenchmarkCardholderId([expiring.pending], async (name, args, deadline) => {
        const response = await expiring.call(name, args, deadline);
        if (name === 'list_cardholders') {
          assert.ok(deadline !== undefined);
          clock = deadline + 1;
        }
        return response;
      }),
      /original read deadline/
    );
    assert.equal(expiring.calls.filter((x) => x.name === 'list_cardholders').length, 1);
  } finally {
    Date.now = now;
  }
  passed++;
  const preferred = fixture(242),
    lower = preferred.rows[0].id;
  preferred.rows[0].email = 'agentcard-benchmark@roselabs.ai';
  const highest = preferred.rows.at(-1);
  assert.ok(highest);
  highest.email = 'higher@invalid.test';
  const priorityCall: AgentCardOrgToolCaller = async (name, args, deadline) =>
    name === 'get_cardholder_kyc_status'
      ? {
          structuredContent: {
            kyc_status: [lower, preferred.approved].includes(String(args.cardholder_id))
              ? 'verified'
              : 'pending',
          },
        }
      : preferred.call(name, args, deadline);
  assert.equal(
    await helper.resolveBenchmarkCardholderId([preferred.approved], priorityCall),
    preferred.approved
  );
  passed++;
  assert.equal(networkCalls, 0);
  assert.equal(dbCalls, 0);
  console.log(
    JSON.stringify({
      passed,
      networkCalls,
      dbCalls,
      fixture_mode: 'isolated synthetic sandbox; no browser/Kernel/provider allocation',
      loaded_actual_module: true,
    })
  );
})().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
