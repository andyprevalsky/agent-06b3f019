#!/usr/bin/env tsx
/**
 * Black-box tests for GET /api/imessage/recent-inbound
 *
 * Domain surface:
 *   GET /api/imessage/recent-inbound — recent inbound messages (`to = 'me'`) for
 *   the user, newest first. Used by the browser agent's OTP relay to read codes
 *   that arrived over iMessage/SMS. Auth: API key + x-user-id (internal worker)
 *   or Bearer token. Query: since (required ISO), limit (1-100), channel (opt).
 *
 * Invariants covered:
 *   - auth boundary: unauthenticated request -> 401
 *   - param validation: missing/invalid `since` -> 400; invalid `channel` -> 400
 *   - filtering: only INBOUND (`to = 'me'`), only within the `since` window, and
 *     only the requested `channel` are returned (outbound / stale / other-channel
 *     rows are excluded)
 *   - tenant isolation: a seeded user only sees its own messages
 *   - cleanup: every test seeds an isolated user and deletes it in `finally`
 *
 * Usage:
 *   BACKEND_API_KEY=... npx tsx src/tests/blackbox/imessage-recent-inbound.blackbox.ts
 */

import { randomUUID } from 'node:crypto';
import { MessageChannel } from '@prisma/client';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { retryWithBackoff } from '../../providers/retry';

config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const RUN_ID = process.env.BLACKBOX_TEST_RUN_ID || `${Date.now()}-${randomUUID().slice(0, 8)}`;

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];

function test(name: string, fn: () => Promise<void>): void {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown }> {
  const response = await retryWithBackoff(
    () =>
      fetch(url, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers },
      }),
    {
      maxRetries: 3,
      fixedDelays: [100, 250],
      component: 'iMessageRecentInboundBlackbox',
    }
  );
  const ct = response.headers.get('content-type');
  const data = ct?.includes('application/json') ? await response.json() : await response.text();
  return { status: response.status, data };
}

function userHeaders(userId: string): Record<string, string> {
  return { 'X-API-Key': API_KEY, 'X-User-Id': userId };
}

async function seedMessage(
  userId: string,
  opts: {
    contact: string;
    from: string;
    to: string;
    channel: MessageChannel;
    timestamp: Date;
    message: string;
  }
): Promise<void> {
  const person = await prisma.person.create({
    data: { userId, firstName: 'Test', lastName: 'Contact', phoneNumber: opts.contact },
  });
  await prisma.messageRecord.create({
    data: {
      personId: person.id,
      userId,
      channel: opts.channel,
      from: opts.from,
      to: opts.to,
      timestamp: opts.timestamp,
      message: opts.message,
      externalId: randomUUID(),
    },
  });
}

async function withSeededUser(fn: (userId: string) => Promise<void>): Promise<void> {
  const userId = `imsg-otp-${RUN_ID}-${randomUUID().slice(0, 8)}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  try {
    await fn(userId);
  } finally {
    await prisma.messageRecord.deleteMany({ where: { person: { userId } } });
    await prisma.person.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

test('recent-inbound -- no auth -> 401', async () => {
  const res = await request(`${BASE_URL}/api/imessage/recent-inbound?since=2026-01-01T00:00:00Z`);
  assert(res.status === 401, `expected 401, got ${res.status}`);
});

test('recent-inbound -- missing since -> 400', async () => {
  await withSeededUser(async (userId) => {
    const res = await request(`${BASE_URL}/api/imessage/recent-inbound`, {
      headers: userHeaders(userId),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });
});

test('recent-inbound -- invalid since -> 400', async () => {
  await withSeededUser(async (userId) => {
    const res = await request(`${BASE_URL}/api/imessage/recent-inbound?since=not-a-date`, {
      headers: userHeaders(userId),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });
});

test('recent-inbound -- invalid channel -> 400', async () => {
  await withSeededUser(async (userId) => {
    const res = await request(
      `${BASE_URL}/api/imessage/recent-inbound?since=2026-01-01T00:00:00Z&channel=BOGUS`,
      { headers: userHeaders(userId) }
    );
    assert(res.status === 400, `expected 400, got ${res.status}`);
  });
});

test('recent-inbound -- returns only recent inbound on the requested channel', async () => {
  await withSeededUser(async (userId) => {
    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms);
    // Only (a) — a recent inbound iMessage — should be returned. The rest are
    // excluded: (b) outbound, (c) stale, (d) a different channel.
    const seeds = [
      {
        contact: 'in',
        from: '262966',
        to: 'me',
        channel: MessageChannel.IMESSAGE,
        timestamp: ago(60_000),
        message: 'Your Amazon code is 123456',
      },
      {
        contact: 'out',
        from: 'me',
        to: '262966',
        channel: MessageChannel.IMESSAGE,
        timestamp: ago(60_000),
        message: 'I sent 999999',
      },
      {
        contact: 'old',
        from: '111111',
        to: 'me',
        channel: MessageChannel.IMESSAGE,
        timestamp: ago(3_600_000),
        message: 'old code 222222',
      },
      {
        contact: 'wa',
        from: 'wa-sender',
        to: 'me',
        channel: MessageChannel.WHATSAPP,
        timestamp: ago(60_000),
        message: 'whatsapp code 333333',
      },
    ];
    for (const s of seeds) {
      await seedMessage(userId, { ...s, contact: `${s.contact}-${randomUUID().slice(0, 6)}` });
    }

    const since = new Date(now - 600_000).toISOString();
    const res = await request(
      `${BASE_URL}/api/imessage/recent-inbound?since=${encodeURIComponent(since)}&channel=IMESSAGE&limit=50`,
      { headers: userHeaders(userId) }
    );
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = res.data as {
      count: number;
      messages: Array<{ from: string; to: string; body: string; channel: string }>;
    };
    assert(
      body.count === 1,
      `expected exactly 1 message, got ${body.count}: ${JSON.stringify(body.messages)}`
    );
    const m = body.messages[0];
    assert(
      m.from === '262966' && m.to === 'me' && m.channel === 'IMESSAGE' && m.body.includes('123456'),
      `wrong message returned: ${JSON.stringify(m)}`
    );
  });
});

async function main(): Promise<void> {
  console.log(`iMessage recent-inbound Black-box Tests (${tests.length} cases, runId=${RUN_ID})`);
  const results: TestResult[] = [];
  for (const { name, fn } of tests) {
    const start = Date.now();
    try {
      await fn();
      results.push({ name, passed: true, duration: Date.now() - start });
    } catch (error) {
      results.push({
        name,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - start,
      });
    }
  }

  for (const r of results) {
    console.log(
      `  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.passed ? '' : ` - ${r.error}`} (${r.duration}ms)`
    );
  }
  const failed = results.filter((r) => !r.passed);
  console.log(`\nResults: ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
