/** HTTP contract for the signed Linq ingress; fixtures never invoke a live supervisor. */
import assert from 'node:assert/strict';
import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
config();

const url = `${process.env.TEST_BASE_URL || 'http://localhost:3001'}/api/linq/webhook`;
const secret = process.env.LINQ_WEBHOOK_SECRET;
const configured = secret !== undefined && secret !== '';
const enabled = process.env.SMS_PROVIDER === 'linq' && Boolean(process.env.LINQ_FROM_PHONE);
const sender = `+1555${randomInt(1000000, 10000000)}`;
const messageId = randomUUID();
const prisma = new PrismaClient();
let count = 0;
function event() {
  return {
    event_type: 'message.received',
    webhook_version: '2026-02-03',
    event_id: randomUUID(),
    data: {
      chat: {
        id: randomUUID(),
        is_group: true,
        owner_handle: { handle: process.env.LINQ_FROM_PHONE || '+12025551234', is_me: true },
      },
      id: messageId,
      direction: 'inbound',
      sender_handle: { handle: sender, is_me: false },
      parts: [{ type: 'text', value: 'must not route' }],
      service: 'iMessage',
    },
  };
}
function headers(body: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  const id = randomUUID();
  const key = Buffer.from((secret || 'whsec_dGVzdA==').replace(/^whsec_/, ''), 'base64');
  return {
    'Content-Type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`,
  };
}
async function post(body: string, signatureHeaders: Record<string, string>) {
  const response = await fetch(url, { method: 'POST', headers: signatureHeaders, body });
  return { status: response.status, body: await response.json() };
}
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  count++;
  console.log(`PASS ${name}`);
}
async function main() {
  try {
    assert.equal(await prisma.user.count({ where: { phone: sender } }), 0);
    await test('unsigned requests fail closed in every environment', async () => {
      const result = await post(JSON.stringify(event()), { 'Content-Type': 'application/json' });
      assert.equal(result.status, 403);
      assert.deepEqual(result.body, { error: 'Invalid signature' });
    });
    await test('forged signatures and malformed signed timestamps are rejected', async () => {
      const body = JSON.stringify(event());
      assert.equal(
        (await post(body, { ...headers(body), 'webhook-signature': 'v1,Zm9yZ2Vk' })).status,
        403
      );
      assert.equal((await post(body, headers(body, 'NaN'))).status, 403);
    });
    await test('authentic expired and future deliveries are rejected', async () => {
      const body = JSON.stringify(event());
      for (const delta of [-360, 360])
        assert.equal(
          (await post(body, headers(body, String(Math.floor(Date.now() / 1000) + delta)))).status,
          403
        );
    });
    await test('raw whitespace is authenticated before JSON decoding', async () => {
      const raw = ` \n${JSON.stringify(event(), null, 2)}\n`;
      const signatureHeaders = headers(raw);
      assert.equal(
        (await post(raw, signatureHeaders)).status,
        configured ? (enabled ? 200 : 503) : 403
      );
      assert.equal((await post(raw.trim(), signatureHeaders)).status, 403);
    });
    await test('signed groups, own echoes, foreign owner lines and status receipts cannot provision', async () => {
      const events = [event(), event(), event(), event()];
      events[1].data.chat.is_group = false;
      events[1].data.direction = 'outbound';
      events[2].data.chat.is_group = false;
      events[2].data.chat.owner_handle.handle = '+19999999999';
      events[3].data.chat.is_group = false;
      events[3].event_type = 'message.delivered';
      for (const value of events) {
        const body = JSON.stringify(value);
        assert.equal(
          (await post(body, headers(body))).status,
          configured ? (enabled ? 200 : 503) : 403
        );
      }
      assert.equal(await prisma.user.count({ where: { phone: sender } }), 0);
      assert.equal(
        await prisma.sharedEphemeralState.count({
          where: { namespace: 'linq-inbound-message', key: { endsWith: messageId } },
        }),
        0
      );
    });
    await test('signed malformed JSON and wrong content type expose bounded errors', async () => {
      const body = '{';
      assert.equal(
        (await post(body, headers(body))).status,
        configured ? (enabled ? 400 : 503) : 403
      );
      const raw = JSON.stringify(event());
      assert.equal(
        (await post(raw, { ...headers(raw), 'Content-Type': 'text/plain' })).status,
        403
      );
    });
    console.log(
      `linq-webhook blackbox: ${count} tests passed (${configured ? 'configured signature' : 'missing-secret fail-closed'} path)`
    );
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
