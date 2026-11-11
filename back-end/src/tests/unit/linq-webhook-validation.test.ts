/* eslint-disable no-console */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  validateLinqSignature,
  parseLinqPayload,
} from '../../domains/linq-webhook/service.validation';

const key = Buffer.from('test-standard-webhooks-secret-32!');
const secret = `whsec_${key.toString('base64')}`;
const now = 1794398400000;
const raw = Buffer.from('{ "text": "héllo 🥀", "n": 1 }\n');
const headers = { id: 'msg_delivery', timestamp: String(now / 1000), signature: '' };
const sign = (body: Buffer | string, id = headers.id, timestamp = headers.timestamp) =>
  `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest('base64')}`;
headers.signature = sign(raw);
let count = 0;
function check(name: string, fn: () => void) {
  fn();
  count++;
  console.log(`PASS ${name}`);
}

check('Standard Webhooks signs exact UTF-8 bytes with prefixed or bare base64 key', () => {
  assert.equal(validateLinqSignature(headers, raw, secret, now), true);
  assert.equal(validateLinqSignature(headers, raw, key.toString('base64'), now), true);
  assert.equal(validateLinqSignature(headers, raw.toString(), secret, now), true);
  assert.equal(
    validateLinqSignature(headers, JSON.stringify(JSON.parse(raw.toString())), secret, now),
    false
  );
});
check('key rotation accepts any valid v1 signature, ignoring unknown versions', () => {
  assert.equal(
    validateLinqSignature(
      { ...headers, signature: `v2,bogus v1,Zm9v ${headers.signature}` },
      raw,
      secret,
      now
    ),
    true
  );
  assert.equal(
    validateLinqSignature(
      { ...headers, signature: headers.signature.replace('v1,', 'v2,') },
      raw,
      secret,
      now
    ),
    false
  );
});
check('missing and malformed credentials always fail closed', () => {
  for (const field of ['id', 'timestamp', 'signature'] as const) {
    assert.equal(
      validateLinqSignature({ ...headers, [field]: undefined }, raw, secret, now),
      false
    );
    assert.equal(validateLinqSignature({ ...headers, [field]: '' }, raw, secret, now), false);
  }
  for (const badSecret of [undefined, '', 'whsec_', 'whsec_!!!!', 'whsec_YQ===', 'whsec_a']) {
    assert.equal(validateLinqSignature(headers, raw, badSecret, now), false);
  }
  assert.equal(validateLinqSignature(headers, undefined, secret, now), false);
  for (const signature of ['v1,', 'v1,!!!!', 'v1,Zm9v', `${headers.signature}!`]) {
    assert.equal(validateLinqSignature({ ...headers, signature }, raw, secret, now), false);
  }
});
check('rejects tampering with id, timestamp, and raw body', () => {
  assert.equal(validateLinqSignature({ ...headers, id: 'other' }, raw, secret, now), false);
  assert.equal(
    validateLinqSignature({ ...headers, timestamp: String(now / 1000 + 1) }, raw, secret, now),
    false
  );
  assert.equal(
    validateLinqSignature(headers, Buffer.concat([raw, Buffer.from(' ')]), secret, now),
    false
  );
});
check('rejects stale and future signed requests beyond five minutes', () => {
  for (const delta of [-301, 301]) {
    const timestamp = String(now / 1000 + delta);
    assert.equal(
      validateLinqSignature(
        { ...headers, timestamp, signature: sign(raw, headers.id, timestamp) },
        raw,
        secret,
        now
      ),
      false
    );
  }
  for (const delta of [-300, 300]) {
    const timestamp = String(now / 1000 + delta);
    assert.equal(
      validateLinqSignature(
        { ...headers, timestamp, signature: sign(raw, headers.id, timestamp) },
        raw,
        secret,
        now
      ),
      true
    );
  }
  for (const timestamp of ['NaN', '1e9', '1.2', '-1', 'Infinity', '9007199254740992', '']) {
    assert.equal(
      validateLinqSignature(
        { ...headers, timestamp, signature: sign(raw, headers.id, timestamp) },
        raw,
        secret,
        now
      ),
      false
    );
  }
});
const owner = '+12025551234';
function event() {
  return {
    event_type: 'message.received',
    webhook_version: '2026-02-03',
    event_id: 'event-1',
    data: {
      chat: { id: 'chat-1', is_group: false, owner_handle: { handle: owner, is_me: true } },
      id: 'message-1',
      direction: 'inbound',
      sender_handle: { handle: '+12025559876', is_me: false },
      parts: [
        { type: 'text', value: 'hello' },
        { type: 'text', value: 'world' },
        {
          type: 'media',
          url: 'https://cdn.linqapp.com/photo.jpg?signature=abc',
          mime_type: 'image/jpeg',
        },
      ] as Array<{ type: string; value?: string; url?: string; mime_type?: string }>,
      service: 'iMessage',
    },
  };
}
check('2026 nested payload maps sender, identity, text, and media to SMS message shape', () => {
  assert.deepEqual(parseLinqPayload(event(), owner), {
    messageId: 'message-1',
    fromPhone: '+12025559876',
    messageBody: 'hello\nworld',
    attachments: [{ url: 'https://cdn.linqapp.com/photo.jpg?signature=abc', type: 'image/jpeg' }],
    chatId: 'chat-1',
    service: 'iMessage',
  });
});
check('accepts attachment-only SMS and RCS with absent MIME hint', () => {
  for (const service of ['SMS', 'RCS']) {
    const value = event();
    value.data.service = service;
    value.data.parts = [{ type: 'media', url: 'https://cdn.linqapp.com/audio' }];
    assert.equal(parseLinqPayload(value, owner)?.attachments[0].type, null);
    assert.equal(parseLinqPayload(value, owner)?.messageBody, '');
  }
});
check('only the active owner line and phone sender are trusted', () => {
  for (const mutate of [
    (e: ReturnType<typeof event>) => {
      e.data.chat.owner_handle.handle = '+12025550000';
    },
    (e: ReturnType<typeof event>) => {
      Reflect.deleteProperty(e.data.chat, 'owner_handle');
    },
    (e: ReturnType<typeof event>) => {
      e.data.chat.owner_handle.is_me = false;
    },
    (e: ReturnType<typeof event>) => {
      e.data.sender_handle.handle = 'person@example.com';
    },
    (e: ReturnType<typeof event>) => {
      e.data.sender_handle.handle = owner;
    },
    (e: ReturnType<typeof event>) => {
      e.data.sender_handle.is_me = true;
    },
    (e: ReturnType<typeof event>) => {
      Reflect.deleteProperty(e.data.sender_handle, 'is_me');
    },
  ]) {
    const e = event();
    mutate(e);
    assert.equal(parseLinqPayload(e, owner), null);
  }
  assert.equal(parseLinqPayload(event(), undefined), null);
  assert.equal(parseLinqPayload(event(), 'bad-phone'), null);
});
check('groups, echoes, receipts, and malformed messages cannot route', () => {
  for (const mutate of [
    (e: ReturnType<typeof event>) => {
      e.data.chat.is_group = true;
    },
    (e: ReturnType<typeof event>) => {
      Reflect.deleteProperty(e.data.chat, 'is_group');
    },
    (e: ReturnType<typeof event>) => {
      e.data.direction = 'outbound';
    },
    (e: ReturnType<typeof event>) => {
      Reflect.deleteProperty(e.data, 'direction');
    },
    (e: ReturnType<typeof event>) => {
      e.data.id = '';
    },
    (e: ReturnType<typeof event>) => {
      e.data.chat.id = '';
    },
    (e: ReturnType<typeof event>) => {
      e.data.parts = [];
    },
    (e: ReturnType<typeof event>) => {
      e.data.parts = [
        { type: 'text', value: '  ' },
        { type: 'media', url: 'file:///etc/passwd' },
      ];
    },
    (e: ReturnType<typeof event>) => {
      e.data.service = 'unknown';
    },
    (e: ReturnType<typeof event>) => {
      e.webhook_version = '2027-01-01';
    },
  ]) {
    const e = event();
    mutate(e);
    assert.equal(parseLinqPayload(e, owner), null);
  }
  for (const type of [
    'message.sent',
    'message.delivered',
    'message.read',
    'message.failed',
    'reaction.added',
    'chat.created',
  ]) {
    const e = event();
    e.event_type = type;
    assert.equal(parseLinqPayload(e, owner), null);
  }
  for (const value of [
    null,
    undefined,
    [],
    {},
    'text',
    { event_type: 'message.received', data: null },
  ])
    assert.equal(parseLinqPayload(value, owner), null);
});
check('legacy 2025 payload requires explicit inbound and matching recipient identity', () => {
  const e = event();
  const d = e.data;
  const legacy = {
    event_type: e.event_type,
    webhook_version: '2025-01-01',
    data: {
      chat_id: d.chat.id,
      from: d.sender_handle.handle,
      from_handle: d.sender_handle,
      is_group: false,
      is_from_me: false,
      recipient_handle: d.chat.owner_handle,
      recipient_phone: undefined as string | undefined,
      message: { id: d.id, parts: d.parts },
      service: d.service,
    },
  };
  assert.deepEqual(parseLinqPayload(legacy, owner), parseLinqPayload(e, owner));
  legacy.data.recipient_handle.handle = '+12025550000';
  assert.equal(parseLinqPayload(legacy, owner), null);
  Reflect.deleteProperty(legacy.data, 'recipient_handle');
  legacy.data.recipient_phone = owner;
  assert.ok(parseLinqPayload(legacy, owner));
  Reflect.deleteProperty(legacy.data, 'recipient_phone');
  assert.equal(parseLinqPayload(legacy, owner), null);
});
console.log(`linq-webhook-validation: ${count} tests passed`);
