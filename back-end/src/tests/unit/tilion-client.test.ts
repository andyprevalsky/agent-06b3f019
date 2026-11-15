#!/usr/bin/env tsx
/**
 * Tilion REST client contract against a fake Tilion server: every error
 * envelope, typed 429/402/busy errors, bounded retries honouring
 * retry_after_seconds, timeout retries only for idempotent calls, X-Request-ID
 * on errors, and no key or CDP/view token in logs.
 */
import assert from 'node:assert/strict';
import { BrowserProviderRateLimitError } from '../../providers/browser/types';
import {
  parseTilionErrorBody,
  postTilionSession,
  redactTilionSecrets,
  TilionApiError,
  TilionInsufficientCreditsError,
  TilionRateLimitError,
  TilionSessionBusyError,
  TilionTimeoutError,
  tilionRequest,
  tilionRequestWithMeta,
} from '../../providers/browser/tilionClient';
import { FakeTilionServer } from './tilion-fake-server.support';

const API_KEY = 'ph_live_unit_secret_key_123';

async function main(): Promise<void> {
  const server = new FakeTilionServer();
  await server.start();
  const previousEnv = { key: process.env.TILION_API_KEY, base: process.env.TILION_BASE_URL };
  process.env.TILION_API_KEY = API_KEY;
  process.env.TILION_BASE_URL = server.baseUrl;
  const logs: string[] = [];
  const writeOut = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  const capture =
    (write: typeof writeOut) =>
    (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      logs.push(String(chunk));
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    };
  process.stdout.write = capture(writeOut) as typeof process.stdout.write;
  process.stderr.write = capture(writeErr) as typeof process.stderr.write;

  try {
    // ── envelope parsing ────────────────────────────────────────────────────
    assert.deepEqual(
      parseTilionErrorBody({ detail: 'No such session' }).message,
      'No such session'
    );
    const object = parseTilionErrorBody({
      detail: { error: 'rate_limited', message: 'slow', retry_after_seconds: 3, retryable: true },
    });
    assert.equal(object.slug, 'rate_limited');
    assert.equal(object.retryAfterSeconds, 3);
    assert.equal(object.retryable, true);
    const list = parseTilionErrorBody({
      detail: [
        { type: 'value_error', loc: ['body', 'region'], msg: 'unknown region', input: 'zz' },
      ],
    });
    assert.equal(list.slug, 'validation_error');
    assert.match(list.message, /body\.region: unknown region/);
    assert.equal(
      parseTilionErrorBody({ status: 'error', detail: 'internal error' }).message,
      'internal error'
    );
    const deadline = parseTilionErrorBody({
      error: 'deadline_exceeded',
      detail: 'late',
      deadline_s: 57,
    });
    assert.equal(deadline.slug, 'deadline_exceeded');
    assert.equal(parseTilionErrorBody({ error: 'mcp failure' }).slug, 'mcp failure');
    assert.equal(parseTilionErrorBody(null).message, 'no error body');

    // ── auth header and request id ──────────────────────────────────────────
    server.route('GET', /^\/v1\/sessions$/, () => ({ status: 200, body: [] }));
    const listed = await tilionRequestWithMeta<unknown[]>('/v1/sessions');
    assert.deepEqual(listed.data, []);
    assert.match(listed.requestId ?? '', /^req\d{13}$/);
    assert.equal(server.requests[0].headers.authorization, `Bearer ${API_KEY}`);

    // ── 429 rate_limited is retried after retry_after_seconds, then succeeds ──
    server.reset();
    let throttled = 0;
    server.route('GET', /^\/v1\/regions$/, () =>
      ++throttled === 1
        ? {
            status: 429,
            body: { detail: { error: 'rate_limited', message: 'x', retry_after_seconds: 0 } },
            headers: { 'Retry-After': '0' },
          }
        : { status: 200, body: [{ code: 'us' }] }
    );
    assert.deepEqual(await tilionRequest('/v1/regions'), [{ code: 'us' }]);
    assert.equal(throttled, 2);

    // ── concurrency_limit is a typed provider rate-limit error, never retried ──
    server.reset();
    server.route('POST', /^\/v1\/session$/, () => ({
      status: 429,
      body: { detail: { error: 'concurrency_limit', message: 'cap 20', limit: 20 } },
      headers: { 'Retry-After': '0' },
    }));
    const capped = await tilionRequest('/v1/session', { method: 'POST', body: {} }).catch((e) => e);
    assert(capped instanceof TilionRateLimitError);
    assert(capped instanceof BrowserProviderRateLimitError);
    assert.equal(capped.provider, 'tilion');
    assert.equal(capped.slug, 'concurrency_limit');
    assert.match(capped.message, /X-Request-ID req\d+/);
    assert.equal(server.requests.length, 1);

    // ── 503 capacity_unavailable: typed "nothing allocated", retried ─────────
    server.reset();
    server.route('POST', /^\/v1\/session$/, () => ({
      status: 503,
      body: { detail: { error: 'capacity_unavailable', message: 'no session capacity' } },
      headers: { 'Retry-After': '0' },
    }));
    const full = await tilionRequest('/v1/session', { method: 'POST', body: {} }).catch((e) => e);
    assert(full instanceof TilionRateLimitError);
    assert(full instanceof BrowserProviderRateLimitError);
    assert.equal(full.status, 503);
    assert.equal(full.slug, 'capacity_unavailable');
    assert.equal(server.requests.length, 3);

    // ── keyed create: capacity retried under one key, then the session ───────
    server.reset();
    let keyedCreates = 0;
    server.route('POST', /^\/v1\/session$/, () =>
      ++keyedCreates <= 3
        ? {
            status: 503,
            body: { detail: { error: 'capacity_unavailable', message: 'no session capacity' } },
            headers: { 'Retry-After': '0' },
          }
        : { status: 201, body: { session_id: 'sess_keyed' } }
    );
    const keyed = await postTilionSession<{ session_id: string }>('rose-key-1', {});
    assert.equal(keyed.session_id, 'sess_keyed');
    assert.equal(server.requests.length, 4);
    assert(server.requests.every((r) => r.headers['idempotency-key'] === 'rose-key-1'));

    // ── keyed create: a later rejection cannot settle an earlier in-flight attempt ──
    server.reset();
    keyedCreates = 0;
    server.route('POST', /^\/v1\/session$/, () =>
      ++keyedCreates === 1
        ? {
            status: 409,
            body: { detail: { error: 'idempotency_key_in_use', message: 'running' } },
            headers: { 'Retry-After': '0' },
          }
        : { status: 400, body: { detail: { error: 'stealth_always_on', message: 'no' } } }
    );
    const unsettled = await postTilionSession('rose-key-2', {}).catch((e) => e);
    assert(unsettled instanceof Error);
    assert(!(unsettled instanceof TilionApiError) && !(unsettled instanceof TilionRateLimitError));
    assert.equal((unsettled as { status?: number }).status, undefined);
    assert.match(unsettled.message, /rose-key-2 is unsettled and may own a browser/);
    assert.equal(server.requests.length, 2);

    // ── 402 insufficient_credits: typed, non-retryable, not retried ──────────
    server.reset();
    server.route('POST', /^\/v1\/session$/, () => ({
      status: 402,
      body: {
        detail: { error: 'insufficient_credits', message: 'top up', required: 3, balance: 0 },
      },
    }));
    const broke = await tilionRequest('/v1/session', { method: 'POST', body: {} }).catch((e) => e);
    assert(broke instanceof TilionInsufficientCreditsError);
    assert.equal(broke.retryable, false);
    assert.equal(broke.status, 402);
    assert.equal(server.requests.length, 1);

    // ── 503 retried a bounded number of times, then a typed failure ──────────
    server.reset();
    server.route('DELETE', /^\/v1\/session\//, () => ({
      status: 503,
      body: { detail: 'session worker unavailable; retry cleanup' },
      headers: { 'Retry-After': '0' },
    }));
    const unavailable = await tilionRequest('/v1/session/sess_1', {
      method: 'DELETE',
      maxAttempts: 3,
    }).catch((e) => e);
    assert(unavailable instanceof TilionApiError);
    assert.equal(unavailable.status, 503);
    assert.equal(server.requests.length, 3);

    // ── 4xx other than 429 is never retried ─────────────────────────────────
    server.reset();
    server.route('POST', /^\/v1\/session$/, () => ({
      status: 422,
      body: { detail: { error: 'ttl_exceeds_plan', message: 'too long', max_ttl: 7200 } },
    }));
    const tooLong = await tilionRequest('/v1/session', { method: 'POST', body: {} }).catch(
      (e) => e
    );
    assert(tooLong instanceof TilionApiError);
    assert.equal(tooLong.slug, 'ttl_exceeds_plan');
    assert.equal(server.requests.length, 1);

    // ── busy session (live behaviour: CDP client attached) ───────────────────
    server.reset();
    server.route('POST', /\/screenshot$/, () => ({
      status: 409,
      body: { detail: { error: 'session_driven_by_client', message: 'attached' } },
    }));
    server.route('POST', /\/files\/fetch$/, () => ({
      status: 502,
      body: {
        detail: { error: 'file_fetch_failed', cause: 'ExternalControlBusy', retryable: true },
      },
    }));
    const busyShot = await tilionRequest('/v1/session/s/screenshot', {
      method: 'POST',
      body: {},
    }).catch((e) => e);
    assert(busyShot instanceof TilionSessionBusyError);
    const busyFile = await tilionRequest('/v1/session/s/files/fetch', {
      method: 'POST',
      body: { url: 'https://x.test/a' },
    }).catch((e) => e);
    assert(busyFile instanceof TilionSessionBusyError);
    assert.equal(server.requests.length, 2, 'busy answers must not be retried');

    // ── timeouts: keyed create retried with the SAME key; act never retried ──
    server.reset();
    let creates = 0;
    server.route('POST', /^\/v1\/session$/, () =>
      ++creates === 1
        ? { status: 201, body: { session_id: 'sess_slow' }, delayMs: 400 }
        : { status: 201, body: { session_id: 'sess_slow' } }
    );
    const created = await tilionRequest<{ session_id: string }>('/v1/session', {
      method: 'POST',
      body: {},
      idempotencyKey: 'rose-key-1',
      retryOnTimeout: true,
      timeoutMs: 150,
    });
    assert.equal(created.session_id, 'sess_slow');
    const keys = server.callsTo('POST', /^\/v1\/session$/).map((r) => r.headers['idempotency-key']);
    assert.deepEqual(keys, ['rose-key-1', 'rose-key-1']);

    // ── a body that stalls after the headers is the same typed, retried timeout ──
    server.reset();
    let stalledCreates = 0;
    server.route('POST', /^\/v1\/session$/, () =>
      ++stalledCreates === 1
        ? { status: 201, body: { session_id: 'sess_stalled' }, bodyDelayMs: 400 }
        : { status: 201, body: { session_id: 'sess_stalled' } }
    );
    const recovered = await tilionRequest<{ session_id: string }>('/v1/session', {
      method: 'POST',
      body: {},
      idempotencyKey: 'rose-key-2',
      retryOnTimeout: true,
      timeoutMs: 150,
    });
    assert.equal(recovered.session_id, 'sess_stalled');
    assert.deepEqual(
      server.callsTo('POST', /^\/v1\/session$/).map((r) => r.headers['idempotency-key']),
      ['rose-key-2', 'rose-key-2']
    );
    server.reset();
    server.route('GET', /^\/v1\/sessions$/, () => ({ status: 200, body: [], bodyDelayMs: 400 }));
    const stalledRead = await tilionRequest('/v1/sessions', {
      timeoutMs: 150,
      maxAttempts: 1,
    }).catch((e) => e);
    assert(stalledRead instanceof TilionTimeoutError, `stalled body: ${String(stalledRead)}`);

    server.reset();
    server.route('POST', /\/act$/, () => ({ status: 200, body: { ok: true }, delayMs: 400 }));
    const slowAct = await tilionRequest('/v1/session/s/act', {
      method: 'POST',
      body: { action: 'press', key: 'Enter' },
      timeoutMs: 150,
    }).catch((e) => e);
    assert(slowAct instanceof TilionTimeoutError);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(
      server.callsTo('POST', /\/act$/).length,
      1,
      'a non-idempotent drive call was repeated'
    );

    // ── redaction ───────────────────────────────────────────────────────────
    assert.equal(
      redactTilionSecrets('wss://h/v1/session/s/cdp?token=abc.def&x=1 Bearer ph_live_zz'),
      'wss://h/v1/session/s/cdp?token=[REDACTED]&x=1 Bearer [REDACTED]'
    );
    server.reset();
    server.route('GET', /\/connect$/, () => ({
      status: 500,
      body: { status: 'error', detail: 'bad wss://h/cdp?token=leaky-token-value' },
    }));
    const leaky = await tilionRequest('/v1/session/s/connect?token=path-token', {
      maxAttempts: 1,
    }).catch((e) => e);
    assert(leaky instanceof TilionApiError);
    assert.doesNotMatch(leaky.message, /leaky-token-value|path-token/);

    const joined = logs.join('');
    assert.match(joined, /Tilion request/, 'requests must be logged');
    assert.match(joined, /req\d{13}/, 'X-Request-ID must be logged');
    assert.doesNotMatch(joined, new RegExp(API_KEY));
    assert.doesNotMatch(joined, /path-token|leaky-token-value/);
    assert.equal(server.requests.filter((r) => r.path.startsWith('/v1/auth')).length, 0);
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
    await server.stop();
    if (previousEnv.key === undefined) delete process.env.TILION_API_KEY;
    else process.env.TILION_API_KEY = previousEnv.key;
    if (previousEnv.base === undefined) delete process.env.TILION_BASE_URL;
    else process.env.TILION_BASE_URL = previousEnv.base;
  }
  process.stdout.write('tilion-client: all assertions passed\n');
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
