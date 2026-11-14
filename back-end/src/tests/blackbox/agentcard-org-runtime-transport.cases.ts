import assert from 'node:assert/strict';
import {
  AgentCardOrgRuntime,
  AgentCardOrgRuntimeError,
} from '../../providers/agentcard/org-runtime';
import { AgentCardOrgMcpProvider } from '../../providers/card-provider/agentcard-org-mcp';

export async function assertTransportRecoveryContract(): Promise<void> {
  const failures: string[] = [];
  async function check(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push(`${name}: ${String(error)}`);
    }
  }
  const clock = () => {
    let nowMs = 1_800_000_000_000;
    const sleeps: number[] = [];
    return {
      now: () => nowMs,
      sleeps,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    };
  };
  const success = () =>
    new Response(JSON.stringify({ result: { structuredContent: { ok: true } } }));

  await check('ambiguous mutation timeouts never replay a committed side effect', async () => {
    let calls = 0;
    const runtime = new AgentCardOrgRuntime(
      undefined,
      async () => {
        calls += 1;
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
      clock()
    );
    await assert.rejects(() => runtime.callTool('recover_funds', { cardholder_id: 'ch-1' }));
    assert.equal(calls, 1, 'a lost mutation response is not proof the mutation failed');
  });

  await check('structured service outages never replay an ambiguous mutation', async () => {
    let calls = 0;
    const runtime = new AgentCardOrgRuntime(
      async () => {
        calls += 1;
        return {
          structuredContent: { status: 'error', message: 'Service temporarily unavailable' },
        };
      },
      undefined,
      clock()
    );
    await assert.rejects(() => runtime.callTool('recover_funds', { cardholder_id: 'ch-1' }));
    assert.equal(calls, 1);
  });

  await check('keyed card creation alone owns safe timeout replays', async () => {
    const intents: unknown[] = [];
    const runtime = new AgentCardOrgRuntime(
      undefined,
      async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          params: { name: string; arguments: Record<string, unknown> };
        };
        const { name, arguments: args } = request.params;
        if (name === 'create_card') {
          intents.push(args);
          if (intents.length === 1) throw new DOMException('Request timed out', 'TimeoutError');
          return new Response(
            JSON.stringify({
              result: {
                structuredContent: {
                  cardId: 'card-1',
                  transfer_id: 'owt-1',
                },
              },
            })
          );
        }
        assert.equal(name, 'get_card_details');
        return new Response(
          JSON.stringify({
            result: {
              structuredContent: {
                pan: '4242424242424242',
                cvv: '123',
                expiry: '12/30',
                balanceCents: 100,
                status: 'OPEN',
              },
            },
          })
        );
      },
      clock()
    );
    const provider = new AgentCardOrgMcpProvider('ch-1', (name, args, deadline) =>
      runtime.callTool(name, args, deadline)
    );
    const minted = await provider.mintCard({
      amountCents: 100,
      idempotencyKey: 'purchase:one-intent',
    });
    assert.equal(minted.cardId, 'card-1');
    assert.equal(intents.length, 2);
    assert.deepEqual(intents[0], intents[1], 'a timeout must preserve the exact funding intent');
  });

  await check('HTTP 5xx never replays a mutation', async () => {
    let calls = 0;
    const runtime = new AgentCardOrgRuntime(
      undefined,
      async () => {
        calls += 1;
        return new Response('upstream disconnected', { status: 503 });
      },
      clock()
    );
    await assert.rejects(() => runtime.callTool('recover_funds', { cardholder_id: 'ch-1' }));
    assert.equal(calls, 1);
  });

  for (const status of [200, 503])
    await check(
      `HTTP ${status} upstream throttle does not replay an unkeyed recovery`,
      async () => {
        let calls = 0;
        const runtime = new AgentCardOrgRuntime(
          undefined,
          async () => {
            calls += 1;
            return new Response(
              JSON.stringify({
                result: {
                  structuredContent: {
                    status: 'error',
                    message: 'API key rate limit exceeded',
                  },
                },
              }),
              { status }
            );
          },
          clock()
        );
        await assert.rejects(() => runtime.callTool('recover_funds', { cardholder_id: 'ch-1' }));
        assert.equal(calls, 1);
      }
    );

  for (const status of [500, 502, 503, 504])
    await check(`HTTP ${status} reads recover with opaque proxy bodies`, async () => {
      let calls = 0;
      const runtime = new AgentCardOrgRuntime(
        undefined,
        async () => {
          calls += 1;
          return calls === 1
            ? new Response('<html>upstream disconnected</html>', { status })
            : success();
        },
        clock()
      );
      assert.deepEqual(await runtime.callTool('list_transfers', {}), {
        structuredContent: { ok: true },
      });
      assert.equal(calls, 2);
    });

  for (const [header, expectedWait] of [
    ['7', 7_250],
    [new Date(1_800_000_007_000).toUTCString(), 7_250],
  ] as const) {
    await check(`HTTP 429 honours Retry-After ${header}`, async () => {
      let calls = 0;
      const retryClock = clock();
      const runtime = new AgentCardOrgRuntime(
        undefined,
        async () => {
          calls += 1;
          return calls === 1
            ? new Response('busy', { status: 429, headers: { 'Retry-After': header } })
            : success();
        },
        retryClock
      );
      assert.deepEqual(await runtime.callTool('get_company_wallet', {}), {
        structuredContent: { ok: true },
      });
      assert.equal(calls, 2);
      assert.deepEqual(retryClock.sleeps, [expectedWait]);
    });
  }

  await check('Retry-After cannot extend the shared retry budget', async () => {
    let calls = 0;
    const retryClock = clock();
    const runtime = new AgentCardOrgRuntime(
      undefined,
      async () => {
        calls += 1;
        return new Response('busy', { status: 429, headers: { 'Retry-After': '31' } });
      },
      retryClock
    );
    await assert.rejects(
      () => runtime.callTool('list_transfers', {}),
      (error: unknown) =>
        error instanceof AgentCardOrgRuntimeError && error.code === 'agentcard_org_mcp_rate_limited'
    );
    assert.equal(calls, 1);
    assert.deepEqual(retryClock.sleeps, []);
  });
  assert.deepEqual(failures, [], 'AgentCard transport recovery contract');
}
