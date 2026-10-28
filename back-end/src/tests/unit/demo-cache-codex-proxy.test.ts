#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Unit tests for the Fast Mode Codex tee-proxy core (code agent).
 *
 * Run: npx tsx src/tests/unit/demo-cache-codex-proxy.test.ts
 */

import assert from 'node:assert';
import { createInMemoryTraceOrdinalReserver } from '../../providers/traceOrdinal';
import {
  canonicalizeCodexResponseRequest,
  codeAgentSlotKey,
  isCacheableCodexRequest,
  resolveCodex,
  rewriteCachedCodexReplayBody,
  type CodexProxyDeps,
} from '../../domains/demo-cache/codexProxy';

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
  deps: CodexProxyDeps;
  store: Map<string, unknown>;
  stats: { cacheGets: number; upstream: number };
} {
  const store = new Map<string, unknown>(Object.entries(seed));
  const stats = { cacheGets: 0, upstream: 0 };
  const deps: CodexProxyDeps = {
    reserveOrdinal,
    cacheGet: async (key) => {
      stats.cacheGets += 1;
      return { hit: store.has(key), value: store.get(key) ?? null };
    },
    cacheSet: async ({ key, value }) => {
      store.set(key, value);
    },
    fetchUpstream: async (method, pathAndQuery, body) => {
      stats.upstream += 1;
      return {
        status: 200,
        contentType: 'text/event-stream',
        body: `event: response.output_text.delta\ndata: {"method":"${method}","path":"${pathAndQuery}","body":${JSON.stringify(body)}}\n\n`,
      };
    },
  };
  return { deps, store, stats };
}

function terminalCodexBody(text: string): string {
  return (
    'event: response.output_item.done\n' +
    `data: {"type":"response.output_item.done","item":{"id":"msg_terminal","type":"message","status":"completed","content":[{"type":"output_text","text":${JSON.stringify(text)}}]}}\n\n` +
    'event: response.completed\n' +
    'data: {"type":"response.completed","response":{"id":"resp_terminal","status":"completed"}}\n\n'
  );
}

async function main(): Promise<void> {
  await test('only POST /backend-api/codex/responses is cacheable', () => {
    assert.strictEqual(isCacheableCodexRequest('POST', '/backend-api/codex/responses'), true);
    assert.strictEqual(isCacheableCodexRequest('GET', '/backend-api/codex/responses'), false);
    assert.strictEqual(isCacheableCodexRequest('POST', '/backend-api/accounts/check'), false);
    return Promise.resolve();
  });

  await test('MISS forwards upstream and writes successful response', async () => {
    const h = makeDeps();
    const body = { model: 'gpt-5.4', input: [{ role: 'user', content: 'hi' }] };
    const r = await resolveCodex(
      'ghash',
      'POST',
      '/backend-api/codex/responses',
      body,
      {},
      h.deps,
      true,
      {
        sessionId: 'miss',
      }
    );
    assert.strictEqual(r.servedFromCache, false);
    assert.strictEqual(r.wrote, true);
    assert.strictEqual(r.cacheable, true);
    assert.strictEqual(r.readEnabled, true);
    assert.strictEqual(r.ordinal, 0);
    assert.strictEqual(r.cacheHitKind, null);
    assert.strictEqual(r.fallbackSourceOrdinal, null);
    assert.strictEqual(r.cacheKey, codeAgentSlotKey('codex', 'ghash', 0));
    assert.strictEqual(h.store.size, 1);
    assert.match(r.body, /response\.output_text\.delta/);
  });

  await test('cacheable Codex responses force serial tool calls before keying and upstream', async () => {
    const h = makeDeps();
    const body = {
      model: 'gpt-5.4',
      input: [{ role: 'user', content: 'hi' }],
      parallel_tool_calls: true,
    };
    let forwardedBody: unknown = null;
    h.deps.fetchUpstream = async (_method, _pathAndQuery, upstreamBody) => {
      forwardedBody = upstreamBody;
      return { status: 200, contentType: 'text/event-stream', body: 'live' };
    };

    const r = await resolveCodex(
      'ghash',
      'POST',
      '/backend-api/codex/responses',
      body,
      {},
      h.deps,
      true,
      {
        sessionId: 'serial',
      }
    );
    const serialBody = canonicalizeCodexResponseRequest(body);
    assert.strictEqual(r.wrote, true);
    assert.deepStrictEqual(forwardedBody, serialBody);
    assert.strictEqual((forwardedBody as Record<string, unknown>).parallel_tool_calls, false);
    assert.strictEqual(h.store.has(codeAgentSlotKey('codex', 'ghash', 0)), true);
  });

  await test('HIT replays same trace slot in a new run without contacting upstream', async () => {
    const body = { model: 'gpt-5.4', input: [{ role: 'user', content: 'hi' }] };
    const h = makeDeps({
      [codeAgentSlotKey('codex', 'ghash', 0)]: {
        status: 200,
        contentType: 'text/event-stream',
        body: 'event: cached\ndata: {"cached":true}\n\n',
      },
    });
    let upstream = 0;
    h.deps.fetchUpstream = async () => {
      upstream += 1;
      return { status: 200, contentType: 'text/event-stream', body: 'live' };
    };
    const r = await resolveCodex(
      'ghash',
      'POST',
      '/backend-api/codex/responses',
      body,
      {},
      h.deps,
      true,
      {
        sessionId: 'hit',
      }
    );
    assert.strictEqual(r.servedFromCache, true);
    assert.strictEqual(r.cacheable, true);
    assert.strictEqual(r.readEnabled, true);
    assert.strictEqual(r.ordinal, 0);
    assert.strictEqual(r.cacheKey, codeAgentSlotKey('codex', 'ghash', 0));
    assert.strictEqual(r.cacheHitKind, 'exact_slot');
    assert.strictEqual(r.fallbackSourceOrdinal, null);
    assert.strictEqual(upstream, 0);
    assert.match(r.body, /"cached":true/);
  });

  await test('HIT uses serial Codex body even when client asks for parallel tools', async () => {
    const body = {
      model: 'gpt-5.4',
      input: [{ role: 'user', content: 'hi' }],
      parallel_tool_calls: true,
    };
    const h = makeDeps({
      [codeAgentSlotKey('codex', 'ghash', 0)]: {
        status: 200,
        contentType: 'text/event-stream',
        body: 'event: cached\ndata: {"cached":true}\n\n',
      },
    });
    const r = await resolveCodex(
      'ghash',
      'POST',
      '/backend-api/codex/responses',
      body,
      {},
      h.deps,
      true,
      {
        sessionId: 'hit-parallel',
      }
    );
    assert.strictEqual(r.servedFromCache, true);
    assert.strictEqual(h.stats.upstream, 0);
    assert.match(r.body, /"cached":true/);
  });

  await test('HIT is trace-slot based, not request-text based', async () => {
    const coldBody = {
      model: 'gpt-5.4',
      input: [
        {
          type: 'function_call_output',
          output: 'added 1 package, and audited 2 packages in 889ms',
        },
      ],
    };
    const hotBody = {
      model: 'gpt-5.4',
      input: [
        {
          type: 'function_call_output',
          output: 'added 1 package, and audited 2 packages in 883ms',
        },
      ],
    };
    const h = makeDeps();
    await resolveCodex(
      'ghash-text',
      'POST',
      '/backend-api/codex/responses',
      coldBody,
      {},
      h.deps,
      false,
      {
        sessionId: 'record-text',
      }
    );
    h.deps.fetchUpstream = async () => {
      throw new Error('upstream should not be called for hot trace-slot replay');
    };
    const r = await resolveCodex(
      'ghash-text',
      'POST',
      '/backend-api/codex/responses',
      hotBody,
      {},
      h.deps,
      true,
      {
        sessionId: 'read-text',
      }
    );
    assert.strictEqual(r.servedFromCache, true);
    assert.match(r.body, /889ms/);
  });

  await test('HIT replays latest terminal slot when Codex asks one extra post-final turn', async () => {
    const terminalBody = terminalCodexBody('done from terminal slot');
    const h = makeDeps({
      [codeAgentSlotKey('codex', 'terminal-extra', 0)]: {
        status: 200,
        contentType: 'text/event-stream',
        body: 'event: cached\ndata: {"cached":0}\n\n',
      },
      [codeAgentSlotKey('codex', 'terminal-extra', 1)]: {
        status: 200,
        contentType: 'text/event-stream',
        body: terminalBody,
      },
    });
    h.deps.fetchUpstream = async () => {
      throw new Error('post-final replay must not call upstream');
    };

    await resolveCodex(
      'terminal-extra',
      'POST',
      '/backend-api/codex/responses',
      { input: ['first'] },
      {},
      h.deps,
      true,
      { sessionId: 'hot-terminal' }
    );
    await resolveCodex(
      'terminal-extra',
      'POST',
      '/backend-api/codex/responses',
      { input: ['second'] },
      {},
      h.deps,
      true,
      { sessionId: 'hot-terminal' }
    );
    const extra = await resolveCodex(
      'terminal-extra',
      'POST',
      '/backend-api/codex/responses',
      { input: ['extra post-final'] },
      {},
      h.deps,
      true,
      { sessionId: 'hot-terminal' }
    );

    assert.strictEqual(extra.servedFromCache, true);
    assert.strictEqual(extra.cacheHitKind, 'terminal_fallback');
    assert.strictEqual(extra.fallbackSourceOrdinal, 1);
    assert.strictEqual(
      extra.fallbackSourceCacheKey,
      codeAgentSlotKey('codex', 'terminal-extra', 1)
    );
    assert.strictEqual(extra.wrote, false);
    assert.match(extra.body, /done from terminal slot/);
    assert.strictEqual(h.stats.upstream, 0);
  });

  await test('HIT remaps cached write_stdin session id to current live process', async () => {
    const requestBody = {
      input: [
        {
          type: 'function_call_output',
          output: 'Process running with session ID 22222',
        },
      ],
    };
    const cachedBody =
      'event: response.function_call_arguments.delta\n' +
      'data: {"type":"response.function_call_arguments.delta","delta":"{\\"session_id\\":11111,\\"chars\\":\\"\\"}","item_id":"fc_1","sequence_number":1}\n\n' +
      'event: response.function_call_arguments.done\n' +
      'data: {"type":"response.function_call_arguments.done","arguments":"{\\"session_id\\":11111,\\"chars\\":\\"\\"}","item_id":"fc_1","sequence_number":2}\n\n' +
      'event: response.output_item.done\n' +
      'data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","name":"write_stdin","arguments":"{\\"session_id\\":11111,\\"chars\\":\\"\\"}"},"sequence_number":3}\n\n';

    const rewritten = rewriteCachedCodexReplayBody(cachedBody, requestBody);
    assert.doesNotMatch(rewritten, /11111/);
    assert.match(rewritten, /\\"session_id\\":22222/);
    assert.match(rewritten, /\\"yield_time_ms\\":30000/);
    assert.match(rewritten, /response\.function_call_arguments\.delta/);
    assert.match(rewritten, /response\.function_call_arguments\.done/);
    assert.match(rewritten, /response\.output_item\.done/);
  });

  await test('HIT does not stretch non-empty write_stdin input', async () => {
    const requestBody = {
      input: [
        {
          type: 'function_call_output',
          output: 'Process running with session ID 22222',
        },
      ],
    };
    const cachedBody =
      'event: response.output_item.done\n' +
      'data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","name":"write_stdin","arguments":"{\\"session_id\\":11111,\\"chars\\":\\"q\\",\\"yield_time_ms\\":1000}"},"sequence_number":1}\n\n';

    const rewritten = rewriteCachedCodexReplayBody(cachedBody, requestBody);
    assert.doesNotMatch(rewritten, /11111/);
    assert.match(rewritten, /\\"session_id\\":22222/);
    assert.match(rewritten, /\\"chars\\":\\"q\\"/);
    assert.match(rewritten, /\\"yield_time_ms\\":1000/);
  });

  await test('record-only skips cache read, forwards upstream, and writes', async () => {
    const body = { model: 'gpt-5.4', input: [{ role: 'user', content: 'hi' }] };
    const seeded = {
      [codeAgentSlotKey('codex', 'ghash', 0)]: {
        status: 200,
        contentType: 'text/event-stream',
        body: 'event: cached\ndata: {"cached":true}\n\n',
      },
    };
    const h = makeDeps(seeded);
    const r = await resolveCodex(
      'ghash',
      'POST',
      '/backend-api/codex/responses',
      body,
      {},
      h.deps,
      false,
      { sessionId: 'record' }
    );
    assert.strictEqual(r.servedFromCache, false);
    assert.strictEqual(r.wrote, true);
    assert.strictEqual(r.cacheable, true);
    assert.strictEqual(r.readEnabled, false);
    assert.strictEqual(r.ordinal, 0);
    assert.strictEqual(r.cacheKey, codeAgentSlotKey('codex', 'ghash', 0));
    assert.strictEqual(h.stats.cacheGets, 0);
    assert.strictEqual(h.stats.upstream, 1);
    assert.match(r.body, /response\.output_text\.delta/);
  });

  await test('non-2xx response is not cached', async () => {
    const h = makeDeps();
    h.deps.fetchUpstream = async () => ({
      status: 429,
      contentType: 'application/json',
      body: '{"error":"rate_limited"}',
    });
    const r = await resolveCodex(
      'ghash',
      'POST',
      '/backend-api/codex/responses',
      { input: [] },
      {},
      h.deps,
      true,
      { sessionId: 'non-2xx' }
    );
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
        body: 'event: live\ndata: {"slot":"retry-success"}\n\n',
      };
    };

    await assert.rejects(
      () =>
        resolveCodex(
          'failed-slot-codex',
          'POST',
          '/backend-api/codex/responses',
          { input: ['first'] },
          {},
          h.deps,
          true,
          { sessionId: 'record-after-failure' }
        ),
      /transient upstream failure/
    );
    const retry = await resolveCodex(
      'failed-slot-codex',
      'POST',
      '/backend-api/codex/responses',
      { input: ['retry'] },
      {},
      h.deps,
      true,
      { sessionId: 'record-after-failure' }
    );
    assert.strictEqual(retry.wrote, true);
    assert.strictEqual(h.store.has(codeAgentSlotKey('codex', 'failed-slot-codex', 0)), true);
    assert.strictEqual(h.store.has(codeAgentSlotKey('codex', 'failed-slot-codex', 1)), false);

    h.deps.fetchUpstream = async () => {
      throw new Error('hot replay should not call upstream');
    };
    const hot = await resolveCodex(
      'failed-slot-codex',
      'POST',
      '/backend-api/codex/responses',
      { input: ['hot'] },
      {},
      h.deps,
      true,
      { sessionId: 'read-after-failure' }
    );
    assert.strictEqual(hot.servedFromCache, true);
    assert.match(hot.body, /retry-success/);
  });

  await test('non-response paths pass through without cache read/write', async () => {
    const h = makeDeps();
    let cacheReads = 0;
    h.deps.cacheGet = async () => {
      cacheReads += 1;
      return { hit: false, value: null };
    };
    const r = await resolveCodex(
      'ghash',
      'POST',
      '/backend-api/accounts/check',
      { account: true },
      {},
      h.deps,
      true,
      { sessionId: 'pass' }
    );
    assert.strictEqual(r.wrote, false);
    assert.strictEqual(cacheReads, 0);
    assert.strictEqual(h.store.size, 0);
    assert.match(r.body, /accounts\/check/);
  });

  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} failed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`\n✅ demo-cache codex proxy: ${passed}/${passed} passed`);
}

void main();
