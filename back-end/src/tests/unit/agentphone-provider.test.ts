#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import { sendAgentPhoneMessage } from '../../providers/agentPhone';

async function main() {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.AGENTPHONE_API_KEY;
  const originalBase = process.env.AGENTPHONE_BASE_URL;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  process.env.AGENTPHONE_API_KEY = 'agentphone-test-key';
  process.env.AGENTPHONE_BASE_URL = 'https://agentphone.example/v1/';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: input.toString(), init: init ?? {} });
    return new Response(
      JSON.stringify({
        id: 'msg-1',
        status: 'sent',
        channel: 'imessage',
        from_number: '+19125550100',
        to_number: '+19729777432',
        conversation_id: 'conv-1',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    const result = await sendAgentPhoneMessage({
      agentId: 'provider-agent-1',
      numberId: 'number-1',
      toNumber: '+19729777432',
      body: 'Immediate from Rose',
    });
    assert.deepStrictEqual(result, {
      id: 'msg-1',
      status: 'sent',
      channel: 'imessage',
      fromNumber: '+19125550100',
      toNumber: '+19729777432',
      conversationId: 'conv-1',
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://agentphone.example/v1/messages');
    assert.strictEqual(calls[0].init.method, 'POST');
    assert.deepStrictEqual(JSON.parse(String(calls[0].init.body)), {
      body: 'Immediate from Rose',
      to_number: '+19729777432',
      number_id: 'number-1',
    });
    assert.strictEqual(
      (calls[0].init.headers as Record<string, string>).Authorization,
      'Bearer agentphone-test-key'
    );

    await sendAgentPhoneMessage({
      fromNumber: '+19125550100',
      toNumber: '+19729777432',
      body: 'Sender selected by phone',
    });
    assert.deepStrictEqual(JSON.parse(String(calls[1].init.body)), {
      body: 'Sender selected by phone',
      to_number: '+19729777432',
      from_number: '+19125550100',
    });

    await sendAgentPhoneMessage({
      agentId: 'provider-agent-only',
      toNumber: '+19729777432',
      body: 'Sender selected by agent',
    });
    assert.deepStrictEqual(JSON.parse(String(calls[2].init.body)), {
      body: 'Sender selected by agent',
      to_number: '+19729777432',
      agent_id: 'provider-agent-only',
    });

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: 'Outbound SMS is not enabled for this account' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    await assert.rejects(
      () =>
        sendAgentPhoneMessage({
          numberId: 'number-1',
          toNumber: '+19729777432',
          body: 'Do not hide provider failure',
        }),
      /HTTP 403.*Outbound SMS is not enabled/
    );

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 'msg-missing-fields', status: 'sent' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    await assert.rejects(
      () =>
        sendAgentPhoneMessage({
          numberId: 'number-1',
          toNumber: '+19729777432',
          body: 'Require a complete receipt',
        }),
      /missing delivery receipt fields/
    );
    console.log('agentphone-provider: 5 passed, 0 failed');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.AGENTPHONE_API_KEY;
    else process.env.AGENTPHONE_API_KEY = originalKey;
    if (originalBase === undefined) delete process.env.AGENTPHONE_BASE_URL;
    else process.env.AGENTPHONE_BASE_URL = originalBase;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
