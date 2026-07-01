#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import { AgentCardProvider, AgentCardProviderError } from '../../providers/card-provider/agentcard';

type CapturedRequest = {
  url: string;
  init: RequestInit;
};

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ❌ ${name}`);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function withFetchMock(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  fn: (requests: CapturedRequest[]) => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const requestInit = init ?? {};
    requests.push({ url, init: requestInit });
    return handler(url, requestInit);
  }) as typeof fetch;
  try {
    await fn(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function provider(): AgentCardProvider {
  return new AgentCardProvider({
    apiKey: 'agentcard-test-key',
    cardholderId: 'cardholder-1234567890',
    baseUrl: 'https://agentcard.test///',
  });
}

async function main(): Promise<void> {
  await test('mints, reads details, and closes cards through AgentCard API', async () => {
    await withFetchMock(
      (url, init) => {
        if (url === 'https://agentcard.test/api/v1/cards' && init.method === 'POST') {
          return jsonResponse({
            id: 'card-1234567890',
            last4: '4242',
            expiry: '12/30',
            amountCents: 2500,
            status: 'ACTIVE',
          });
        }
        if (url === 'https://agentcard.test/api/v1/cards/card-1234567890/details') {
          return jsonResponse({
            pan: '4242424242424242',
            cvv: '123',
            expiry: '12/30',
            balanceCents: 2500,
            status: 'ACTIVE',
          });
        }
        if (
          url === 'https://agentcard.test/api/v1/cards/card-1234567890' &&
          init.method === 'DELETE'
        ) {
          return new Response(null, { status: 204 });
        }
        return jsonResponse({ error: 'unexpected request' }, 500);
      },
      async (requests) => {
        const subject = provider();
        const minted = await subject.mintCard({ amountCents: 2500, idempotencyKey: 'idem-1' });
        assert.deepStrictEqual(minted, {
          cardId: 'card-1234567890',
          last4: '4242',
          expiry: '12/30',
          spendLimitCents: 2500,
          status: 'ACTIVE',
        });

        const details = await subject.getDetails('card-1234567890');
        assert.strictEqual(details.pan, '4242424242424242');
        assert.strictEqual(details.balanceCents, 2500);

        await subject.closeCard('card-1234567890');

        assert.strictEqual(requests.length, 3);
        assert.strictEqual(
          (requests[0].init.headers as Record<string, string>)['Authorization'],
          'Bearer agentcard-test-key'
        );
        assert.strictEqual(
          (requests[0].init.headers as Record<string, string>)['Idempotency-Key'],
          'idem-1'
        );
        assert.strictEqual(
          requests[0].init.body,
          JSON.stringify({ amountCents: 2500, cardholderId: 'cardholder-1234567890' })
        );
      }
    );
  });

  await test('rejects invalid local requests before calling AgentCard', async () => {
    await withFetchMock(
      () => jsonResponse({ error: 'should not be called' }, 500),
      async (requests) => {
        const subject = provider();
        await assert.rejects(
          () => subject.mintCard({ amountCents: 0 }),
          /amountCents must be a positive integer/
        );
        await assert.rejects(() => subject.getDetails('   '), /cardId is required/);
        await assert.rejects(() => subject.closeCard(''), /cardId is required/);
        assert.strictEqual(requests.length, 0);
      }
    );
  });

  await test('surfaces AgentCard API and schema errors', async () => {
    await withFetchMock(
      (url) => {
        if (url.endsWith('/details'))
          return jsonResponse({
            pan: '',
            cvv: '123',
            expiry: '12/30',
            balanceCents: 1,
            status: 'ACTIVE',
          });
        return new Response('upstream unavailable', { status: 502 });
      },
      async () => {
        const subject = provider();
        await assert.rejects(
          () => subject.mintCard({ amountCents: 100 }),
          (err: unknown) => err instanceof AgentCardProviderError && err.status === 502
        );
        await assert.rejects(
          () => subject.getDetails('bad/details'),
          /AgentCard response missing pan/
        );
      }
    );
  });

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }

  console.log(`\n✅ ${passed} AgentCard provider tests passed`);
}

void main();
