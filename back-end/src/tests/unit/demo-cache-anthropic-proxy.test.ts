#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Unit tests for the Fast Mode Anthropic tee-proxy core (code agent).
 *
 * Exercises resolveAnthropic with injected deps (no DB, no network):
 *  - #20/#22 MISS forwards upstream + writes; HIT replays without upstream
 *  - #21 only successful responses are cached
 *  - #8  non-2xx (partial/failed) is never cached
 *  - #26 secrets are stripped before the value is stored
 *  - #10 replay after write hits without a second upstream call
 *
 * Run: npx tsx src/tests/unit/demo-cache-anthropic-proxy.test.ts
 */

import assert from 'node:assert';
import { createInMemoryTraceOrdinalReserver } from '../../providers/traceOrdinal';
import {
  anthropicSlotKey,
  resolveAnthropic,
  requestSeq,
  type ProxyDeps,
} from '../../domains/demo-cache/anthropicProxy';

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

// One process-wide sequence, as the proxy cores had before ordinals became shared.
const reserveOrdinal = createInMemoryTraceOrdinalReserver();

function makeDeps(seed: Record<string, unknown> = {}): {
  deps: ProxyDeps;
  store: Map<string, unknown>;
  stats: { cacheGets: number; upstream: number };
} {
  const store = new Map<string, unknown>(Object.entries(seed));
  const stats = { cacheGets: 0, upstream: 0 };
  const deps: ProxyDeps = {
    reserveOrdinal,
    cacheGet: async (key) => {
      stats.cacheGets += 1;
      return { hit: store.has(key), value: store.get(key) ?? null };
    },
    cacheSet: async ({ key, value }) => {
      store.set(key, value);
    },
    fetchUpstream: async (body) => {
      stats.upstream += 1;
      return {
        status: 200,
        contentType: 'text/event-stream',
        body: `event: message\ndata: {"ok":true,"turn":${requestSeq(body)}}\n\n`,
      };
    },
  };
  return { deps, store, stats };
}

async function main(): Promise<void> {
  await test('MISS forwards upstream and writes (#20/#22)', async () => {
    const h = makeDeps();
    const r = await resolveAnthropic('ghash', { messages: [{ role: 'user' }] }, {}, h.deps, true, {
      sessionId: 'miss',
    });
    assert.strictEqual(r.servedFromCache, false);
    assert.strictEqual(r.wrote, true);
    assert.strictEqual(r.status, 200);
    assert.match(r.body, /"ok":true/);
    assert.strictEqual(h.store.size, 1); // wrote one entry
  });

  await test('HIT replays without contacting upstream (#22)', async () => {
    const body = { messages: [{ role: 'user' }] };
    const seeded = {
      [anthropicSlotKey('ghash', 0)]: {
        status: 200,
        contentType: 'text/event-stream',
        body: 'event: message\ndata: {"cached":true}\n\n',
      },
    };
    const h = makeDeps(seeded);
    let upstream = 0;
    h.deps.fetchUpstream = async () => {
      upstream += 1;
      return { status: 200, contentType: 'text/event-stream', body: 'live' };
    };
    const r = await resolveAnthropic('ghash', body, {}, h.deps, true, { sessionId: 'hit' });
    assert.strictEqual(r.servedFromCache, true);
    assert.strictEqual(upstream, 0); // never called upstream
    assert.match(r.body, /"cached":true/);
  });

  await test('record-only skips cache read, forwards upstream, and writes', async () => {
    const body = { messages: [{ role: 'user' }] };
    const seeded = {
      [anthropicSlotKey('ghash', 0)]: {
        status: 200,
        contentType: 'text/event-stream',
        body: 'event: message\ndata: {"cached":true}\n\n',
      },
    };
    const h = makeDeps(seeded);
    const r = await resolveAnthropic('ghash', body, {}, h.deps, false, { sessionId: 'record' });
    assert.strictEqual(r.servedFromCache, false);
    assert.strictEqual(r.wrote, true);
    assert.strictEqual(h.stats.cacheGets, 0);
    assert.strictEqual(h.stats.upstream, 1);
    assert.match(r.body, /"ok":true/);
  });

  await test('non-2xx upstream is NOT cached (#8)', async () => {
    const h = makeDeps();
    h.deps.fetchUpstream = async () => ({
      status: 500,
      contentType: 'application/json',
      body: '{"error":1}',
    });
    const r = await resolveAnthropic('ghash', { messages: [{ role: 'user' }] }, {}, h.deps, true, {
      sessionId: 'non-2xx',
    });
    assert.strictEqual(r.wrote, false);
    assert.strictEqual(h.store.size, 0);
  });

  await test('failed upstream call does not consume a trace slot', async () => {
    const h = makeDeps();
    let calls = 0;
    h.deps.fetchUpstream = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('transient upstream failure');
      }
      return {
        status: 200,
        contentType: 'text/event-stream',
        body: 'event: message\ndata: {"slot":"retry-success"}\n\n',
      };
    };

    await assert.rejects(
      () =>
        resolveAnthropic(
          'failed-slot-anthropic',
          { messages: [{ role: 'user', content: 'first' }] },
          {},
          h.deps,
          true,
          { sessionId: 'record-after-failure' }
        ),
      /transient upstream failure/
    );
    const retry = await resolveAnthropic(
      'failed-slot-anthropic',
      { messages: [{ role: 'user', content: 'retry' }] },
      {},
      h.deps,
      true,
      { sessionId: 'record-after-failure' }
    );
    assert.strictEqual(retry.wrote, true);
    assert.strictEqual(h.store.has(anthropicSlotKey('failed-slot-anthropic', 0)), true);
    assert.strictEqual(h.store.has(anthropicSlotKey('failed-slot-anthropic', 1)), false);

    h.deps.fetchUpstream = async () => {
      throw new Error('hot replay should not call upstream');
    };
    const hot = await resolveAnthropic(
      'failed-slot-anthropic',
      { messages: [{ role: 'user', content: 'hot' }] },
      {},
      h.deps,
      true,
      { sessionId: 'read-after-failure' }
    );
    assert.strictEqual(hot.servedFromCache, true);
    assert.match(hot.body, /retry-success/);
  });

  await test('secrets stripped from stored value (#26)', async () => {
    const store = new Map<string, unknown>();
    const deps: ProxyDeps = {
      reserveOrdinal,
      cacheGet: async () => ({ hit: false, value: null }),
      cacheSet: async ({ key, value }) => {
        store.set(key, value);
      },
      fetchUpstream: async () => ({ status: 200, contentType: 'text/event-stream', body: 'ok' }),
    };
    await resolveAnthropic(
      'ghash',
      { messages: [], authorization: 'Bearer secret', 'x-api-key': 'k' },
      {},
      deps,
      true,
      { sessionId: 'secrets' }
    );
    const stored = JSON.stringify([...store.values()]);
    assert.ok(!/Bearer secret/.test(stored), 'authorization must not be stored');
    assert.ok(!/x-api-key/.test(stored), 'x-api-key must not be stored');
  });

  await test('requestSeq still reports message count for diagnostics', () => {
    assert.strictEqual(requestSeq({ messages: [1, 2, 3] }), 3);
    assert.strictEqual(requestSeq({}), 0);
    return Promise.resolve();
  });

  await test('trace-slot key does not include Anthropic request content', async () => {
    const h = makeDeps();
    await resolveAnthropic(
      'trace-content',
      { messages: [{ role: 'user', content: 'cold text' }] },
      {},
      h.deps,
      false,
      { sessionId: 'record-content' }
    );
    h.deps.fetchUpstream = async () => {
      throw new Error('upstream should not be called for hot trace-slot replay');
    };
    const r = await resolveAnthropic(
      'trace-content',
      { messages: [{ role: 'user', content: 'hot text' }] },
      {},
      h.deps,
      true,
      { sessionId: 'read-content' }
    );
    assert.strictEqual(r.servedFromCache, true);
    assert.match(r.body, /"ok":true/);
  });

  await test('Claude Code base-url model TTL suffix is stripped before forward and keying', async () => {
    const h = makeDeps();
    let forwarded: unknown = null;
    h.deps.fetchUpstream = async (body) => {
      forwarded = body;
      return { status: 200, contentType: 'text/event-stream', body: 'ok' };
    };
    const body = { model: 'claude-opus-4-8[1m]', messages: [{ role: 'user', content: 'x' }] };
    const r = await resolveAnthropic('g', body, {}, h.deps, true, { sessionId: 'ttl' });
    assert.strictEqual(r.wrote, true);
    assert.strictEqual((forwarded as { model: string }).model, 'claude-opus-4-8');
    assert.ok(h.store.has(anthropicSlotKey('g', 0)));
  });

  await test('same live session advances slots; new session replays slot zero (#10)', async () => {
    const h = makeDeps();
    let upstream = 0;
    h.deps.fetchUpstream = async (body) => {
      upstream += 1;
      return { status: 200, contentType: 'text/event-stream', body: `v${requestSeq(body)}` };
    };
    const msg = { messages: [{ role: 'user' }] };
    await resolveAnthropic('g2', msg, {}, h.deps, false, { sessionId: 'record-session' }); // slot 0
    await resolveAnthropic('g2', msg, {}, h.deps, false, { sessionId: 'record-session' }); // slot 1
    const r = await resolveAnthropic('g2', msg, {}, h.deps, true, { sessionId: 'read-session' }); // slot 0
    assert.strictEqual(upstream, 2);
    assert.strictEqual(r.servedFromCache, true);
    assert.strictEqual(r.body, 'v1');
  });

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`\n✅ demo-cache anthropic proxy: ${passed}/${passed} passed`);
}

void main();
