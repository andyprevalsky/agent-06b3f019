/**
 * Internal hub-to-hub auth: only signed, fresh, private-network requests pass.
 *
 * Run: npx tsx --test src/tests/unit/local-device-instance-routing.test.ts
 */
import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { internalAuthMatches } from '../../providers/localDevices/instanceRouting';

const SECRET = 'unit-relay-secret';

function signed(at: number, secret = SECRET): string {
  const mac = createHmac('sha256', secret).update(`local-device-hub-internal:${at}`).digest('hex');
  return `${at}.${mac}`;
}

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

test('accepts a fresh signature from a direct peer', () => {
  assert.equal(
    internalAuthMatches(request({ 'x-rose-hub-auth': signed(Date.now()) }), SECRET),
    true
  );
});

test('refuses a stale (replayed) signature', () => {
  const old = Date.now() - 5 * 60_000;
  assert.equal(internalAuthMatches(request({ 'x-rose-hub-auth': signed(old) }), SECRET), false);
});

test('refuses a request that came through the public load balancer', () => {
  const headers = { 'x-rose-hub-auth': signed(Date.now()), 'x-forwarded-for': '203.0.113.9' };
  assert.equal(internalAuthMatches(request(headers), SECRET), false);
});

test('refuses a wrong secret or a missing header', () => {
  assert.equal(
    internalAuthMatches(request({ 'x-rose-hub-auth': signed(Date.now(), 'other') }), SECRET),
    false
  );
  assert.equal(internalAuthMatches(request({}), SECRET), false);
});
