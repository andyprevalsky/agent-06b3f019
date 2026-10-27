#!/usr/bin/env tsx
/**
 * S19: E2B refuses creates over the team's concurrent-sandbox cap with HTTP 429
 * (RateLimitError). No sandbox exists after a refusal, so the create waits for
 * a slot instead of failing the code agent on the first refusal.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthenticationError, RateLimitError, Sandbox } from 'e2b';
import { createSandboxWithRetry, e2bCapacityWaitMs } from '../../providers/e2bSandboxCreate';

type CreateFn = typeof Sandbox.create;
const realCreate = Sandbox.create;

function stubCreate(results: Array<Error | 'ok'>): { calls: number } {
  const state = { calls: 0 };
  (Sandbox as unknown as { create: unknown }).create = async () => {
    const next = results[Math.min(state.calls, results.length - 1)];
    state.calls += 1;
    if (next instanceof Error) throw next;
    return { sandboxId: 'sbx-s19' } as unknown as Awaited<ReturnType<CreateFn>>;
  };
  return state;
}

test.afterEach(() => {
  (Sandbox as unknown as { create: CreateFn }).create = realCreate;
});

const noSleep = async () => {};
const wait = { waitMs: 30_000, sleep: noSleep };

test('waits through concurrent-sandbox refusals, then creates', async () => {
  const state = stubCreate([
    new RateLimitError('Rate limit exceeded, please try again later - concurrent sandboxes'),
    new RateLimitError('Rate limit exceeded, please try again later - concurrent sandboxes'),
    'ok',
  ]);
  const sandbox = await createSandboxWithRetry('tpl', {}, 's19', wait);
  assert.equal(sandbox.sandboxId, 'sbx-s19');
  assert.equal(state.calls, 3);
});

test('gives up with the provider error once the capacity wait is spent', async () => {
  const state = stubCreate([new RateLimitError('Rate limit exceeded')]);
  await assert.rejects(
    createSandboxWithRetry('tpl', {}, 's19', { waitMs: 0, sleep: noSleep }),
    RateLimitError
  );
  assert.equal(state.calls, 1);
});

test('callers that do not opt in fail fast (synchronous user paths)', async () => {
  const state = stubCreate([new RateLimitError('Rate limit exceeded'), 'ok']);
  await assert.rejects(createSandboxWithRetry('tpl', {}, 's19'), RateLimitError);
  assert.equal(state.calls, 1);
});

test('the default code-agent wait fits inside the agent create request (60s)', () => {
  delete process.env.E2B_CAPACITY_WAIT_MS;
  assert.ok(e2bCapacityWaitMs() < 60_000);
});

test('non-capacity rejections still fail immediately', async () => {
  const state = stubCreate([new AuthenticationError('bad key')]);
  await assert.rejects(createSandboxWithRetry('tpl', {}, 's19', wait), AuthenticationError);
  assert.equal(state.calls, 1);
});
