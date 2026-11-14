import path from 'node:path';
import { assertV2SetupResumeContract } from './agentcard-v2-setup-contract.cases';
import assert from 'node:assert/strict';
import { AgentCardV2Client, AgentCardV2Error } from '../../providers/agentcard/api-v2';

async function main(): Promise<void> {
  assertV2SetupResumeContract(path.resolve(__dirname, '../../..'));
  const config = () => ({
    baseUrl: 'https://api.example.test',
    clientId: 'client',
    clientSecret: 'secret',
  });
  const success = () => new Response(JSON.stringify({ object: 'company_wallet' }));
  for (const kind of [
    'seconds',
    'date',
    'unavailable',
    'unauthorized',
    'invalid-code',
    'mutation',
  ] as const) {
    let now = 1_800_000_000_000;
    let tokens = 0;
    let calls = 0;
    const waits: number[] = [];
    const client = new AgentCardV2Client(
      async (url) => {
        if (String(url).endsWith('/oauth/token')) {
          tokens += 1;
          return new Response(
            JSON.stringify({ access_token: `token-${tokens}`, expires_in: 3600 })
          );
        }
        calls += 1;
        if (calls > 1) return success();
        if (kind === 'seconds' || kind === 'date')
          return new Response('proxy busy', {
            status: 429,
            headers: {
              'Retry-After': kind === 'seconds' ? '7' : new Date(now + 7000).toUTCString(),
            },
          });
        if (kind === 'unauthorized' || kind === 'invalid-code')
          return new Response(
            JSON.stringify({
              error: { code: kind === 'unauthorized' ? 'unauthorized' : 'invalid_code' },
            }),
            { status: 401 }
          );
        return new Response('proxy error', { status: 503 });
      },
      config,
      {
        now: () => now,
        sleep: async (ms) => {
          waits.push(ms);
          now += ms;
        },
      }
    );
    if (kind === 'invalid-code') {
      await assert.rejects(
        () => client.request('POST', '/api/v2/connect/verify', { code: '000000' }),
        (error: unknown) => error instanceof AgentCardV2Error && error.code === 'invalid_code'
      );
      assert.equal(tokens, 1);
      assert.equal(calls, 1);
    } else if (kind === 'mutation') {
      await assert.rejects(
        () => client.request('POST', '/api/v2/connect/verify', { code: '111111' }),
        (error: unknown) => error instanceof AgentCardV2Error && error.status === 503
      );
      assert.equal(calls, 1, 'a single-use OTP cannot be replayed after a lost response');
    } else {
      assert.deepEqual(await client.request('GET', '/api/v2/company_wallet'), {
        object: 'company_wallet',
      });
      assert.equal(calls, 2);
      assert.equal(tokens, kind === 'unauthorized' ? 2 : 1);
      assert.deepEqual(
        waits,
        kind === 'unauthorized' ? [] : [kind === 'unavailable' ? 1000 : 7250]
      );
    }
  }
  let requests = 0;
  let now = 1_800_000_000_000;
  const bodies: string[] = [];
  const keys: string[] = [];
  const client = new AgentCardV2Client(
    async (url, init) => {
      if (String(url).endsWith('/oauth/token'))
        return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }));
      requests += 1;
      bodies.push(String(init?.body));
      keys.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      if (requests === 1) throw new DOMException('Lost response', 'TimeoutError');
      return success();
    },
    config,
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    }
  );
  await client.request(
    'POST',
    '/api/v2/cards',
    { user_id: 'usr_x', amount_cents: 100 },
    'purchase:stable'
  );
  assert.deepEqual(bodies, [bodies[0], bodies[0]]);
  assert.deepEqual(keys, ['purchase:stable', 'purchase:stable']);
  assert.equal(requests, 2);
  await assert.rejects(
    () => client.request('GET', 'https://other.example/api/v2/cards'),
    /Invalid AgentCard/
  );
  process.stdout.write(
    'PASS AgentCard v2 token refresh, typed retries, Retry-After and stable mutation intents\n'
  );
}
void main();
