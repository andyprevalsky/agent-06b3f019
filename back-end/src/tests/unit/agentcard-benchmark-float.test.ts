#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_MIN_SANDBOX_FLOAT_CENTS,
  ensureAgentCardSandboxFloat,
  ensureBenchmarkOrgCardholder,
  resolveBenchmarkCardholderId,
  verifyBenchmarkOrgFixture,
  waitOutBenchmarkOrgBackpressure,
} from '../../providers/agentcard/benchmark-float';
import {
  AgentCardOrgRuntime,
  AgentCardOrgRuntimeError,
  type AgentCardOrgToolCaller,
} from '../../providers/agentcard/org-runtime';

const ORG_ENV_NAMES = [
  'AGENTCARD_ORG_MCP_ACCESS_TOKEN',
  'AGENTCARD_ORG_OAUTH_CLIENT_ID',
  'AGENTCARD_ORG_OAUTH_CLIENT_SECRET',
] as const;

/** Run against the real org runtime so its rate-limit handling is exercised, not bypassed. */
async function withOrgRuntime(
  toolResults: (toolName: string, call: number) => unknown,
  run: (callOrgTool: AgentCardOrgToolCaller, calls: () => number) => Promise<void>
): Promise<void> {
  const original = Object.fromEntries(ORG_ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ORG_ENV_NAMES) delete process.env[name];
  process.env.AGENTCARD_ORG_MCP_ACCESS_TOKEN = 'direct-org-token';
  let calls = 0;
  let virtualNowMs = Date.now();
  const runtime = new AgentCardOrgRuntime(
    async (_token, toolName) => {
      calls += 1;
      return toolResults(toolName, calls);
    },
    fetch,
    {
      now: () => virtualNowMs,
      sleep: async (ms) => {
        virtualNowMs += ms;
      },
    }
  );
  try {
    await run(
      (toolName, args, deadlineAtMs) => runtime.callTool(toolName, args, deadlineAtMs),
      () => calls
    );
  } finally {
    for (const name of ORG_ENV_NAMES) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const API_KEY_THROTTLE_MESSAGE =
  'get_cardholder_kyc_status failed: API key rate limit exceeded, please try again later';

const API_KEY_THROTTLE_RESULTS: unknown[] = [
  { structuredContent: { status: 'error', message: API_KEY_THROTTLE_MESSAGE } },
  { isError: true, content: [{ type: 'text', text: API_KEY_THROTTLE_MESSAGE }] },
];

function walletResult(cents: {
  balance: number;
  committed?: number;
  available: number;
  livemode?: boolean;
}): unknown {
  return {
    structuredContent: {
      wallet: {
        object: 'org_wallet',
        livemode: cents.livemode ?? false,
        balance_cents: cents.balance,
        committed_cents: cents.committed ?? 0,
        available_cents: cents.available,
        stablecoin: 'usdc',
      },
    },
  };
}

function cardholdersResult(cardholders: Array<{ id: string; email?: string }>): unknown {
  return {
    structuredContent: {
      message: `${cardholders.length} cardholder(s); showing ${cardholders.length}.`,
      cardholders,
      total: cardholders.length,
    },
  };
}

/** The predeploy selector's hard cap (agents/benchmarks/select_predeploy_benches.py DEFAULT_CAP). */
const PREDEPLOY_HARD_CAP = 20;

async function main(): Promise<void> {
  // The sandbox lifecycle tasks run concurrently in smoke, one card per guest: the default floor must
  // cover a full-cap selection each holding the largest sandbox lifecycle reservation at once.
  {
    const catalog = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../../../agents/benchmarks/tasks.json'), 'utf8')
    ) as Array<{
      name: string;
      tags?: string[];
      production_only?: boolean;
      expected_payment_receipt?: { totalCents?: number };
    }>;
    const sandbox = catalog.filter(
      (task) => task.tags?.includes('agentcard-lifecycle-sandbox') && task.production_only !== true
    );
    const smoke = sandbox.filter((task) => task.tags?.includes('smoke')).map((task) => task.name);
    assert.deepEqual(smoke.sort(), [
      'agent-payment-abandonment',
      'agent-payment-idempotent-abandonment',
      'agent-payment-setup-resume',
      'agent-payment-test-shop',
    ]);
    const largest = Math.max(
      ...sandbox.map((task) => task.expected_payment_receipt?.totalCents ?? 0)
    );
    assert.ok(largest > 0, 'sandbox lifecycle tasks declare their reservation');
    assert.ok(
      DEFAULT_MIN_SANDBOX_FLOAT_CENTS >= PREDEPLOY_HARD_CAP * largest,
      `default floor ${DEFAULT_MIN_SANDBOX_FLOAT_CENTS} < ${PREDEPLOY_HARD_CAP} x ${largest}`
    );
    const saved = process.env.BENCHMARK_AGENTCARD_MIN_FLOAT_CENTS;
    delete process.env.BENCHMARK_AGENTCARD_MIN_FLOAT_CENTS;
    try {
      const funded = async () =>
        walletResult({
          balance: DEFAULT_MIN_SANDBOX_FLOAT_CENTS,
          available: DEFAULT_MIN_SANDBOX_FLOAT_CENTS,
        });
      await ensureAgentCardSandboxFloat(undefined, funded);
      const short = async () =>
        walletResult({ balance: 50_000, available: DEFAULT_MIN_SANDBOX_FLOAT_CENTS - 1 });
      await assert.rejects(ensureAgentCardSandboxFloat(undefined, short), /sandbox pool too low/);
    } finally {
      if (saved === undefined) delete process.env.BENCHMARK_AGENTCARD_MIN_FLOAT_CENTS;
      else process.env.BENCHMARK_AGENTCARD_MIN_FLOAT_CENTS = saved;
    }
  }

  // A sufficiently funded sandbox pool reads clean via client-credential MCP.
  {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const callOrgTool = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return walletResult({ balance: 32_416, available: 32_416 });
    };
    const float = await ensureAgentCardSandboxFloat(10_000, callOrgTool);
    assert.deepEqual(float, { balanceCents: 32_416, availableCents: 32_416, committedCents: 0 });
    assert.equal(calls.length, 1, 'reads the wallet exactly once');
    assert.equal(calls[0].name, 'get_company_wallet');
    assert.deepEqual(calls[0].args, {}, 'org identity travels in the client-credential token');
  }

  // Committed holds are surfaced but available is what gates the floor.
  {
    const callOrgTool = async () =>
      walletResult({ balance: 20_000, committed: 4_396, available: 15_604 });
    const float = await ensureAgentCardSandboxFloat(10_000, callOrgTool);
    assert.deepEqual(float, {
      balanceCents: 20_000,
      availableCents: 15_604,
      committedCents: 4_396,
    });
  }

  // Shared sandbox rate limits expose an absolute retry timestamp. Bootstrap waits for the
  // advertised window and retries instead of failing the lifecycle gate before a task exists.
  {
    let calls = 0;
    const callOrgTool = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('Streamable HTTP error: {"error":"Rate limit exceeded","retryAfter":0}');
      }
      return walletResult({ balance: 32_416, available: 32_416 });
    };
    const float = await ensureAgentCardSandboxFloat(10_000, callOrgTool);
    assert.equal(calls, 2, 'retries a rate-limited wallet read');
    assert.equal(float.availableCents, 32_416);
  }

  // Non-rate-limit failures remain immediate and are never masked by retries.
  {
    let calls = 0;
    const callOrgTool = async () => {
      calls += 1;
      throw new Error('authentication failed');
    };
    await assert.rejects(ensureAgentCardSandboxFloat(10_000, callOrgTool), /authentication failed/);
    assert.equal(calls, 1, 'does not retry unrelated failures');
  }

  // A pool below the floor fails loud and early with an actionable, non-interactive message.
  {
    const callOrgTool = async () => walletResult({ balance: 5_000, available: 5_000 });
    await assert.rejects(ensureAgentCardSandboxFloat(10_000, callOrgTool), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /sandbox pool too low/i);
      assert.match(message, /\$50\.00 available/);
      assert.match(message, /\$100\.00 required/);
      assert.match(message, /no interactive login/i);
      return true;
    });
  }

  // A malformed wallet response is rejected rather than silently passing.
  {
    const callOrgTool = async () => ({ structuredContent: {} });
    await assert.rejects(ensureAgentCardSandboxFloat(10_000, callOrgTool), /no structured wallet/i);
  }

  // A live wallet is rejected before the floor check so the benchmark never draws
  // on live funds, even when it is amply funded.
  {
    const callOrgTool = async () =>
      walletResult({ balance: 1_000_000, available: 1_000_000, livemode: true });
    await assert.rejects(ensureAgentCardSandboxFloat(10_000, callOrgTool), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /live wallet/i);
      assert.match(message, /sandbox/i);
      return true;
    });
  }

  // A cardholder resolver that answers list_cardholders and per-id KYC status.
  const cardholderOrg = (
    cardholders: Array<{ id: string; email?: string }>,
    kycById: Record<string, string>,
    calls?: string[]
  ) => {
    return async (name: string, args?: Record<string, unknown>) => {
      calls?.push(name);
      if (name === 'get_cardholder_kyc_status') {
        const id = String(args?.cardholder_id ?? '');
        return { structuredContent: { status: kycById[id] ?? 'pending' } };
      }
      return cardholdersResult(cardholders);
    };
  };

  // Stale BENCHMARK_AGENTCARD_CARDHOLDER_ID must not win over a live AGENTCARD_CARDHOLDER_ID.
  {
    const calls: string[] = [];
    const resolved = await resolveBenchmarkCardholderId(
      ['ch-stale-missing', 'ch-live'],
      cardholderOrg(
        [
          { id: 'ch-live', email: 'agentcard-benchmark@roselabs.ai' },
          { id: 'ch-other', email: 'a@roselabs.ai' },
        ],
        { 'ch-live': 'verified', 'ch-other': 'verified' },
        calls
      )
    );
    assert.equal(resolved, 'ch-live');
    assert.equal(calls[0], 'list_cardholders');
  }

  // When every configured id is missing, prefer andy@ (live KYC) over agentcard-benchmark@.
  {
    const resolved = await resolveBenchmarkCardholderId(['ch-stale'], async () =>
      cardholdersResult([
        { id: 'ch-bench', email: 'agentcard-benchmark@roselabs.ai' },
        { id: 'ch-andy', email: 'andy@roselabs.ai' },
        { id: 'ch-other', email: 'a@roselabs.ai' },
      ])
    );
    assert.equal(resolved, 'ch-andy');
  }

  // Sandbox orgs without andy@ fall back to the verified agentcard-benchmark@ cardholder.
  {
    const resolved = await resolveBenchmarkCardholderId(
      ['ch-stale'],
      cardholderOrg(
        [
          { id: 'ch-live', email: 'agentcard-benchmark@roselabs.ai' },
          { id: 'ch-other', email: 'a@roselabs.ai' },
        ],
        { 'ch-live': 'verified', 'ch-other': 'verified' }
      )
    );
    assert.equal(resolved, 'ch-live');
  }

  // REGRESSION: a preferred id that exists but is stuck at KYC `pending` must NOT be selected when
  // a verified cardholder is available. Real failure (2026-08-21): the sandbox org held exactly
  // this pair, AGENTCARD_CARDHOLDER_ID named the pending one, and the payment lifecycle gate died
  // at bootstrap with "cardholder is not KYC-ready" while a verified cardholder sat beside it.
  {
    const resolved = await resolveBenchmarkCardholderId(
      ['ch-pending'],
      cardholderOrg(
        [
          { id: 'ch-pending', email: 'a@roselabs.ai' },
          { id: 'ch-verified', email: 'agentcard-benchmark@roselabs.ai' },
        ],
        { 'ch-pending': 'pending', 'ch-verified': 'verified' }
      )
    );
    assert.equal(resolved, 'ch-verified');
  }

  // `approved` is terminal and mint-capable, exactly like `verified`.
  {
    const resolved = await resolveBenchmarkCardholderId(
      ['ch-pending'],
      cardholderOrg(
        [
          { id: 'ch-pending', email: 'a@roselabs.ai' },
          { id: 'ch-approved', email: 'other@roselabs.ai' },
        ],
        { 'ch-pending': 'pending', 'ch-approved': 'approved' }
      )
    );
    assert.equal(resolved, 'ch-approved');
  }

  // When nothing is verified, return the preferred id unchanged so the caller's more specific
  // KYC error is what the operator sees.
  {
    const resolved = await resolveBenchmarkCardholderId(
      ['ch-pending'],
      cardholderOrg(
        [
          { id: 'ch-pending', email: 'a@roselabs.ai' },
          { id: 'ch-other', email: 'agentcard-benchmark@roselabs.ai' },
        ],
        { 'ch-pending': 'pending', 'ch-other': 'rejected' }
      )
    );
    assert.equal(resolved, 'ch-pending');
  }

  // A cardholder whose KYC read throws must not abort resolution — another may be verified.
  {
    const resolved = await resolveBenchmarkCardholderId(
      ['ch-broken'],
      async (name: string, args?: Record<string, unknown>) => {
        if (name === 'get_cardholder_kyc_status') {
          const id = String(args?.cardholder_id ?? '');
          if (id === 'ch-broken') throw new Error('kyc read failed');
          return { structuredContent: { status: 'verified' } };
        }
        return cardholdersResult([
          { id: 'ch-broken', email: 'a@roselabs.ai' },
          { id: 'ch-good', email: 'agentcard-benchmark@roselabs.ai' },
        ]);
      }
    );
    assert.equal(resolved, 'ch-good');
  }

  // An empty org fails closed with an actionable message.
  {
    await assert.rejects(
      resolveBenchmarkCardholderId(['ch-stale'], async () => cardholdersResult([])),
      /no cardholders/i
    );
  }

  // Wallet float alone is insufficient: the cardholder must exist in the OAuth org.
  {
    const callOrgTool = async (name: string) => {
      if (name === 'get_cardholder_kyc_status') {
        throw new Error('get_cardholder_kyc_status failed: Cardholder not found');
      }
      throw new Error(`unexpected tool ${name}`);
    };
    await assert.rejects(
      () => ensureBenchmarkOrgCardholder('cardholder-missing', callOrgTool),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /does not exist in the OAuth org/i);
        assert.match(message, /wallet float passed/i);
        return true;
      }
    );
  }

  // A present cardholder must also be KYC-ready before the lifecycle gate proceeds.
  {
    const callOrgTool = async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_cardholder_kyc_status') {
        assert.equal(args.cardholder_id, 'cardholder-pending');
        return {
          structuredContent: { kyc_status: 'pending' },
        };
      }
      throw new Error(`unexpected tool ${name}`);
    };
    await assert.rejects(
      () => ensureBenchmarkOrgCardholder('cardholder-pending', callOrgTool),
      /not KYC-ready \(pending\)/i
    );
  }

  {
    const callOrgTool = async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_cardholder_kyc_status') {
        assert.equal(args.cardholder_id, 'cardholder-ready');
        return {
          structuredContent: { kyc_status: 'verified' },
        };
      }
      throw new Error(`unexpected tool ${name}`);
    };
    const status = await ensureBenchmarkOrgCardholder('cardholder-ready', callOrgTool);
    assert.deepEqual(status, { verificationStatus: 'verified' });
  }

  // REGRESSION (agent-payment-new-user-journey, 2026-10-02): AgentCard returns its upstream
  // API-key throttle as an HTTP-200 tool error, not a transport 429. The org runtime handed it
  // back as a successful read, so the readiness check failed on the first refusal with no retry.
  for (const throttled of API_KEY_THROTTLE_RESULTS) {
    await withOrgRuntime(
      (toolName, call) => {
        assert.equal(toolName, 'get_cardholder_kyc_status');
        return call === 1 ? throttled : { structuredContent: { kyc_status: 'verified' } };
      },
      async (callOrgTool, calls) => {
        const status = await ensureBenchmarkOrgCardholder('cardholder-ready', callOrgTool);
        assert.deepEqual(status, { verificationStatus: 'verified' });
        assert.equal(calls(), 2, 'a throttled KYC read must be retried, not surfaced');
      }
    );
  }

  // A throttle that never clears stays bounded and fails closed with an attributable error.
  await withOrgRuntime(
    () => API_KEY_THROTTLE_RESULTS[0],
    async (callOrgTool, calls) => {
      await assert.rejects(
        () => ensureBenchmarkOrgCardholder('cardholder-ready', callOrgTool),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /cardholder readiness check failed/i);
          assert.match(message, /rate limit exhausted for get_cardholder_kyc_status/i);
          assert.match(message, /API key rate limit exceeded/);
          return true;
        }
      );
      assert.equal(calls(), 5, 'rate-limit retries on a read must stay bounded');
    }
  );

  // An org-wide throttle is not evidence about one cardholder: resolution must fail closed rather
  // than spend more requests on the next candidate, and every read shares ONE retry budget.
  {
    const kycReads: string[] = [];
    const deadlines = new Set<number | undefined>();
    const callOrgTool: AgentCardOrgToolCaller = async (name, args, deadlineAtMs) => {
      deadlines.add(deadlineAtMs);
      if (name === 'get_cardholder_kyc_status') {
        kycReads.push(String(args.cardholder_id));
        throw new AgentCardOrgRuntimeError(
          `AgentCard Organization MCP rate limit exhausted for ${name} after 3 attempts`,
          429,
          'agentcard_org_mcp_rate_limited'
        );
      }
      return cardholdersResult([
        { id: 'ch-andy', email: 'andy@roselabs.ai' },
        { id: 'ch-bench', email: 'agentcard-benchmark@roselabs.ai' },
      ]);
    };
    await assert.rejects(
      () => resolveBenchmarkCardholderId(['ch-andy'], callOrgTool),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError && error.code === 'agentcard_org_mcp_rate_limited'
    );
    assert.deepEqual(kycReads, ['ch-andy'], 'no further candidates are read once throttled');
    assert.equal(deadlines.size, 1, 'list + KYC reads share one rate-limit deadline');
    assert.equal(typeof [...deadlines][0], 'number');
  }

  // REGRESSION (PR #1786 deploy attempt 4 smoke, 2026-11-08): a provider 401 on the first pre-barrier
  // list_cardholders failed setup-benchmark-payment.ts, and one such INFRA_ERROR stopped all 13 jobs.
  {
    const unauthorized = (tool: string) =>
      new AgentCardOrgRuntimeError(
        `AgentCard Organization MCP ${tool} failed: Invalid or expired organization token`,
        401,
        'agentcard_org_mcp_unauthorized',
        { status: 401 }
      );
    const throttled = (tool: string) =>
      new AgentCardOrgRuntimeError(
        `AgentCard Organization MCP rate limit exhausted for ${tool} after 3 attempts`,
        429,
        'agentcard_org_mcp_rate_limited'
      );
    const healthyOrg = (name: string, args: Record<string, unknown>): Record<string, unknown> => {
      if (name === 'list_cardholders') {
        return cardholdersResult([{ id: 'ch-ready', email: 'agentcard-benchmark@roselabs.ai' }]);
      }
      if (name === 'get_cardholder_kyc_status') {
        assert.equal(args.cardholder_id, 'ch-ready');
        return { structuredContent: { kyc_status: 'verified' } };
      }
      if (name === 'get_company_wallet') {
        return walletResult({ balance: 200_000, available: 200_000 });
      }
      if (name === 'whoami') return { structuredContent: { mode: 'sandbox' } };
      throw new Error(`unexpected tool ${name}`);
    };

    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };
    let listCalls = 0;
    const flapping: AgentCardOrgToolCaller = async (name, args) => {
      if (name === 'list_cardholders') {
        listCalls += 1;
        if (listCalls === 1) throw unauthorized(name);
        if (listCalls === 2) throw throttled(name);
      }
      return healthyOrg(name, args);
    };
    const fixture = await verifyBenchmarkOrgFixture(flapping, { sleep });
    assert.equal(fixture.cardholderId, 'ch-ready');
    assert.equal(fixture.cardholderVerificationStatus, 'verified');
    assert.equal(fixture.sandboxFloat.availableCents, 200_000);
    assert.deepEqual(sleeps, [30_000, 30_000], 'backpressure waits out the shared window');

    // A sustained outage stays bounded and surfaces the provider's own error.
    let outageCalls = 0;
    const outage: AgentCardOrgToolCaller = async (name) => {
      outageCalls += 1;
      throw unauthorized(name);
    };
    const outageSleeps: number[] = [];
    await assert.rejects(
      () =>
        verifyBenchmarkOrgFixture(outage, {
          sleep: async (ms) => {
            outageSleeps.push(ms);
          },
        }),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        error.status === 401 &&
        /Invalid or expired organization token/.test(error.message)
    );
    assert.equal(outageCalls, 4, 'one initial attempt plus three bounded retries');
    assert.deepEqual(outageSleeps, [30_000, 30_000, 30_000]);

    // A real fixture defect is not backpressure and must fail on the first pass, with no wait.
    let defectSleeps = 0;
    const emptyOrg: AgentCardOrgToolCaller = async () => cardholdersResult([]);
    await assert.rejects(
      () =>
        verifyBenchmarkOrgFixture(emptyOrg, {
          sleep: async () => {
            defectSleeps += 1;
          },
        }),
      /no cardholders/
    );
    assert.equal(defectSleeps, 0, 'non-backpressure failures must not be retried');

    // Nested per-call retries must not multiply the total wait: no new pass past the elapsed cap.
    let cappedPasses = 0;
    let clockMs = 0;
    await assert.rejects(
      () =>
        waitOutBenchmarkOrgBackpressure(
          async () => {
            cappedPasses += 1;
            clockMs += 100_000; // one pass consumed its full nested per-call retry budget
            throw throttled('get_company_wallet');
          },
          { now: () => clockMs, sleep: async () => undefined }
        ),
      /rate limit exhausted/
    );
    assert.equal(cappedPasses, 2, 'the elapsed cap stops new passes before the retry count');

    // An exhausted transient outage is the same provider state; a permanent 502 is not.
    let unavailablePasses = 0;
    assert.equal(
      await waitOutBenchmarkOrgBackpressure(
        async () => {
          unavailablePasses += 1;
          if (unavailablePasses === 1) {
            throw new AgentCardOrgRuntimeError(
              'AgentCard Organization MCP list_cardholders is temporarily unavailable',
              503,
              'agentcard_org_mcp_unavailable'
            );
          }
          return 'ready';
        },
        { sleep: async () => undefined }
      ),
      'ready'
    );
    let permanentPasses = 0;
    await assert.rejects(() =>
      waitOutBenchmarkOrgBackpressure(
        async () => {
          permanentPasses += 1;
          throw new AgentCardOrgRuntimeError(
            'AgentCard Organization MCP list_cardholders failed: bad gateway',
            502,
            'agentcard_org_mcp_unavailable'
          );
        },
        { sleep: async () => undefined }
      )
    );
    assert.equal(permanentPasses, 1, 'a non-transient 502 fails on the first pass');

    // A provider 401 says nothing about the cardholder being read. Treating it as not-ready used
    // to fall through and return a less-preferred, unverified cardholder for seeding.
    const kycFlap: AgentCardOrgToolCaller = async (name, args) => {
      if (name === 'list_cardholders') {
        return cardholdersResult([
          { id: 'ch-pending', email: 'pending@roselabs.ai' },
          { id: 'ch-ready', email: 'ready@roselabs.ai' },
        ]);
      }
      if (args.cardholder_id === 'ch-ready') throw unauthorized(name);
      return { structuredContent: { kyc_status: 'pending' } };
    };
    await assert.rejects(
      () => resolveBenchmarkCardholderId(['ch-pending', 'ch-ready'], kycFlap),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError && error.code === 'agentcard_org_mcp_unauthorized'
    );

    // The readiness wrapper keeps its message but must stay classifiable as backpressure.
    await assert.rejects(
      () =>
        ensureBenchmarkOrgCardholder('ch-ready', async (name) => {
          throw unauthorized(name);
        }),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError &&
        error.code === 'agentcard_org_mcp_unauthorized' &&
        /cardholder readiness check failed/i.test(error.message)
    );
  }

  process.stdout.write('AgentCard benchmark sandbox float tests passed\n');
}

void main();
