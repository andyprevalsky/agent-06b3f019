#!/usr/bin/env tsx
/**
 * E2B capacity is never waited on (directed by Andy, 2026-10-27): when E2B
 * refuses a create over the plan's concurrent-sandbox limit (HTTP 429,
 * RateLimitError), the create fails at once with E2BSandboxCapacityError, the
 * #errors alert fires, and routes answer 503 E2B_CAPACITY_EXHAUSTED with the
 * same message. No retry, no queue.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { AuthenticationError, RateLimitError, Sandbox, ServiceBusyError } from 'e2b';
import { codeSessionHttpError } from '../../providers/codeSessions/spawn';
import { createSandboxWithRetry, E2BSandboxCapacityError } from '../../providers/e2bSandboxCreate';
import { __resetAlertThrottleForTests } from '../../providers/errorAlert';

const CAPACITY_MESSAGE =
  'E2B concurrent-sandbox limit reached: every sandbox allowed by the current E2B plan ' +
  'is in use, so no new sandbox can start. Scale the E2B plan to run more code agents.';

type CreateFn = typeof Sandbox.create;
type ListFn = typeof Sandbox.list;
const realCreate = Sandbox.create;
const realList = Sandbox.list;
const alerts: string[] = [];
let server: Server;

function stubCreate(...results: Array<Error | 'ok'>): { calls: number; options: unknown[] } {
  const state = { calls: 0, options: [] as unknown[] };
  (Sandbox as unknown as { create: unknown }).create = async (_tpl: string, options: unknown) => {
    const next = results[Math.min(state.calls, results.length - 1)];
    state.calls += 1;
    state.options.push(options);
    if (next instanceof Error) throw next;
    return { sandboxId: 'sbx-ok' };
  };
  return state;
}

/** Alerts are fire-and-forget; give the local webhook POST time to land. */
function settleAlerts(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 300));
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      // Count only alert posts: the devbox daemon probes new listeners with HEAD /.
      if (req.method === 'POST' && req.url === '/hook') alerts.push(body);
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_ERROR_CHANNEL_ID;
  process.env.SLACK_ERROR_WEBHOOK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
});

after(async () => {
  (Sandbox as unknown as { create: CreateFn }).create = realCreate;
  (Sandbox as unknown as { list: ListFn }).list = realList;
  delete process.env.SLACK_ERROR_WEBHOOK_URL;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  // Let a previous case's fire-and-forget alert POST finish before resetting.
  await new Promise((resolve) => setTimeout(resolve, 150));
  alerts.length = 0;
  await __resetAlertThrottleForTests();
});

test('an E2B 429 fails fast with the typed capacity error and fires the alert', async () => {
  const state = stubCreate(
    new RateLimitError('Rate limit exceeded, please try again later - concurrent sandboxes')
  );
  await assert.rejects(createSandboxWithRetry('tpl', {}, 'Claude Code'), (error: unknown) => {
    assert.ok(error instanceof E2BSandboxCapacityError);
    assert.equal(error.message, CAPACITY_MESSAGE);
    assert.equal(error.code, 'E2B_CAPACITY_EXHAUSTED');
    return true;
  });
  assert.equal(state.calls, 1, 'no retry and no wait after a capacity refusal');
  // The SDK's own Retry-After loop is off too, so a 429 surfaces at once.
  assert.equal((state.options[0] as { retries?: number }).retries, 0);
  await settleAlerts();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /E2B concurrent-sandbox limit reached/);
});

test('repeat refusals share one throttled alert signature', async () => {
  stubCreate(new RateLimitError('Rate limit exceeded'));
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(createSandboxWithRetry('tpl', {}, 'Claude Code'), E2BSandboxCapacityError);
  }
  await settleAlerts();
  assert.equal(alerts.length, 1);
});

test('code-session routes answer 503 E2B_CAPACITY_EXHAUSTED with the same message', () => {
  assert.deepEqual(codeSessionHttpError(new E2BSandboxCapacityError('429')), {
    status: 503,
    body: { error: CAPACITY_MESSAGE, code: 'E2B_CAPACITY_EXHAUSTED' },
  });
});

test('other create rejections are unchanged and do not alert as capacity', async () => {
  const state = stubCreate(new AuthenticationError('bad key'));
  await assert.rejects(createSandboxWithRetry('tpl', {}, 'Claude Code'), AuthenticationError);
  assert.equal(state.calls, 1);
  await settleAlerts();
  assert.equal(alerts.length, 0);
});

test('a busy 503 is still retried as a transient blip, not reported as capacity', async () => {
  // The retry first checks for an orphan from attempt 1: none exists.
  (Sandbox as unknown as { list: unknown }).list = () => ({ nextItems: async () => [] });
  const state = stubCreate(new ServiceBusyError('Service temporarily unavailable'), 'ok');
  const sandbox = await createSandboxWithRetry('tpl', {}, 'Claude Code');
  assert.equal(sandbox.sandboxId, 'sbx-ok');
  assert.equal(state.calls, 2);
  await settleAlerts();
  assert.equal(alerts.length, 0);
});
