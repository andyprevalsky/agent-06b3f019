#!/usr/bin/env tsx

import assert from 'node:assert';
import { retryWithBackoff } from '../../providers/retry';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * The dedupe slot is DB-backed (SharedEphemeralState), so under coverage load
 * an expected alert can land after a fixed 30 ms sleep. Wait (bounded) for it.
 */
const waitForCalls = (calls: unknown[], expected: number): Promise<void> =>
  retryWithBackoff(
    async () => {
      if (calls.length < expected) throw new Error(`waiting for ${expected} alert(s)`);
    },
    {
      maxRetries: 40,
      getBackoffDelayMs: () => 50,
      isRetryable: () => true,
      component: 'ErrorAlertTest',
    }
  ).catch(() => undefined);

interface Captured {
  url: string;
  body: unknown;
}

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const oldWebhook = process.env.SLACK_ERROR_WEBHOOK_URL;
  const oldBotToken = process.env.SLACK_BOT_TOKEN;
  const oldChannel = process.env.SLACK_ERROR_CHANNEL_ID;
  const oldRca = process.env.AUTO_RCA_ENABLED;
  const oldToken = process.env.GITHUB_DISPATCH_TOKEN;

  // The bot-token path resolves through the Slack Web API; every other suite runs
  // through the webhook path, so keep the bot env unset unless a case opts in.
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_ERROR_CHANNEL_ID;

  const calls: Captured[] = [];
  let failNext = false;
  let rejections = 0;
  const rejectionEvents: unknown[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (failNext) {
      failNext = false;
      rejections += 1;
      rejectionEvents.push(input);
      throw new Error('simulated network failure');
    }
    const url = String(input);
    calls.push({
      url,
      body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined,
    });
    // chat.postMessage must return JSON with ok/ts so the lifecycle handle resolves.
    if (url.includes('slack.com/api/chat.postMessage')) {
      return new Response(
        JSON.stringify({ ok: true, ts: '1700000000.000100', channel: 'C_TEST' }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
    return new Response('ok', { status: 200 });
  }) as typeof fetch;

  const { alertError, __resetAlertThrottleForTests } = await import('../../providers/errorAlert');

  try {
    // --- 1. Posts to Slack when webhook is configured ---
    process.env.SLACK_ERROR_WEBHOOK_URL = 'https://hooks.slack.test/xxx';
    delete process.env.AUTO_RCA_ENABLED;
    await __resetAlertThrottleForTests();
    calls.length = 0;

    alertError({
      source: 'agent_workflow',
      message: 'db pool timeout after 42ms',
      agentId: 'agent-abc',
      stack: 'Error: db pool timeout\n    at worker.ts:42',
      context: { reason: 'pool exhausted', attempts: 3 },
    });
    await sleep(30);
    await waitForCalls(calls, 1);
    assert.strictEqual(calls.length, 1, 'should post exactly one Slack alert');
    assert.strictEqual(calls[0].url, 'https://hooks.slack.test/xxx', 'posts to the webhook url');
    const payload = calls[0].body as { text: string; blocks: unknown[] };
    assert.ok(payload.text.includes('db pool timeout'), 'payload carries the message');
    assert.ok(Array.isArray(payload.blocks) && payload.blocks.length >= 3, 'payload has blocks');
    const renderedBlocks = JSON.stringify(payload.blocks);
    assert.ok(renderedBlocks.includes('*Context:*'), 'payload carries diagnostic context');
    assert.ok(renderedBlocks.includes('pool exhausted'), 'payload serializes context values');
    assert.ok(renderedBlocks.includes('*Stack:*'), 'payload carries the stack trace');

    // --- 2. Identical signature within the window is throttled (deduped) ---
    calls.length = 0;
    alertError({
      source: 'agent_workflow',
      message: 'db pool timeout after 42ms',
      agentId: 'agent-abc',
    });
    await sleep(30);
    assert.strictEqual(calls.length, 0, 'duplicate signature must be throttled');

    // Signatures normalize out UUIDs/numbers, so a message differing ONLY by a
    // number is the same signature and stays throttled.
    alertError({
      source: 'agent_workflow',
      message: 'db pool timeout after 9001ms',
      agentId: 'agent-abc',
    });
    await sleep(30);
    assert.strictEqual(calls.length, 0, 'number-only difference collapses to the same signature');

    // --- 3. A genuinely different signature alerts again ---
    calls.length = 0;
    alertError({ source: 'sms', message: 'totally different failure', userId: 'u1' });
    await sleep(30);
    await waitForCalls(calls, 1);
    assert.strictEqual(calls.length, 1, 'distinct signature should alert');

    // --- 4. No webhook configured → no fetch, no throw ---
    delete process.env.SLACK_ERROR_WEBHOOK_URL;
    await __resetAlertThrottleForTests();
    calls.length = 0;
    alertError({ source: 'chat', message: 'no webhook here', agentId: 'a' });
    await sleep(30);
    assert.strictEqual(calls.length, 0, 'no webhook → no outbound call');
    process.env.SLACK_ERROR_WEBHOOK_URL = 'https://hooks.slack.test/xxx';
    alertError({ source: 'chat', message: 'no webhook here', agentId: 'a' });
    await sleep(30);
    await waitForCalls(calls, 1);
    assert.strictEqual(calls.length, 1, 'a missing sink must not spend the throttle slot');

    // --- 5. Never throws even when fetch rejects ---
    process.env.SLACK_ERROR_WEBHOOK_URL = 'https://hooks.slack.test/xxx';
    await __resetAlertThrottleForTests();
    calls.length = 0;
    failNext = true;
    alertError({ source: 'chat', message: 'fetch will reject', agentId: 'a' });
    await sleep(30); // if this throws unhandled, the process crashes → test fails
    // The slot is released when the rejection settles, which is DB-backed and lands after a fixed
    // sleep under coverage load; an identical alert sent before that is throttled by design. Send it
    // until it lands: a rejection that spent the slot for good never lets one through.
    await waitForCalls(rejectionEvents, 1);
    assert.strictEqual(rejections, 1, 'the first alert reached the rejecting transport');
    for (let attempt = 0; attempt < 40 && calls.length < 1; attempt++) {
      alertError({ source: 'chat', message: 'fetch will reject', agentId: 'a' });
      await sleep(50);
    }
    await waitForCalls(calls, 1);
    assert.strictEqual(calls.length, 1, 'a rejected transport remains retryable');

    // --- 6. AUTO_RCA_ENABLED=1 never dispatches to GitHub: RCA runs on Rose,
    //         driven by the Slack card this alert posts. ---
    process.env.AUTO_RCA_ENABLED = '1';
    process.env.GITHUB_DISPATCH_TOKEN = 'ghp_test';
    await __resetAlertThrottleForTests();
    calls.length = 0;
    alertError({ source: 'agent_workflow', message: 'rca please', agentId: 'agent-rca' });
    await sleep(30);
    await waitForCalls(calls, 1);
    assert.strictEqual(calls.length, 1, 'Auto RCA still posts exactly one Slack card');
    assert.strictEqual(calls[0].url, 'https://hooks.slack.test/xxx', 'card goes to Slack');
    assert.ok(
      calls.every((c) => !c.url.includes('api.github.com')),
      'Auto RCA must not fire a GitHub repository_dispatch'
    );

    // --- 7. A broad incident alerts every affected agent; the auto-RCA webhook
    //         (not this emitter) collapses one signature into one RCA agent. ---
    calls.length = 0;
    alertError({ source: 'sms', message: 'provider outage 42', agentId: 'incident-agent-a' });
    await sleep(30);
    alertError({ source: 'sms', message: 'provider outage 99', agentId: 'incident-agent-b' });
    await sleep(30);
    assert.strictEqual(
      calls.filter((c) => c.url === 'https://hooks.slack.test/xxx').length,
      2,
      'each affected agent keeps its own Slack card'
    );
    assert.ok(
      calls.every((c) => !c.url.includes('api.github.com')),
      'no GitHub dispatch'
    );
    delete process.env.AUTO_RCA_ENABLED;
    delete process.env.GITHUB_DISPATCH_TOKEN;

    // --- 9. Slack non-2xx is handled without throwing ---
    let non2xxCalls = 0;
    globalThis.fetch = (async () => {
      non2xxCalls += 1;
      return new Response('nope', { status: 500 });
    }) as typeof fetch;
    delete process.env.AUTO_RCA_ENABLED;
    await __resetAlertThrottleForTests();
    alertError({ source: 'sms', message: 'slack rejects this one', userId: 'u2' });
    await sleep(30); // must not throw despite the 500
    alertError({ source: 'sms', message: 'slack rejects this one', userId: 'u2' });
    await sleep(30);
    assert.strictEqual(non2xxCalls, 2, 'a non-2xx Slack response remains immediately retryable');

    // Restore the JSON-aware mock for the bot-token suite.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.includes('slack.com/api/chat.postMessage')) {
        return new Response(
          JSON.stringify({ ok: true, ts: '1700000000.000100', channel: 'C_TEST' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    // --- 10. With the bot token, Auto RCA posts the card through the Web API to
    //         the configured channel. That top-level bot card is the event the
    //         Slack auto-RCA webhook turns into a Rose RCA agent. ---
    delete process.env.SLACK_ERROR_WEBHOOK_URL;
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_ERROR_CHANNEL_ID = 'C_INPUT';
    process.env.AUTO_RCA_ENABLED = '1';
    await __resetAlertThrottleForTests();
    calls.length = 0;
    alertError({ source: 'agent_workflow', message: 'bot token path', agentId: 'agent-bot' });
    await sleep(30);
    const slackPosts = calls.filter((c) => c.url.includes('slack.com/api/chat.postMessage'));
    assert.strictEqual(slackPosts.length, 1, 'Auto RCA posts one bot card');
    const card = slackPosts[0].body as { channel: string; thread_ts?: string; text: string };
    assert.strictEqual(card.channel, 'C_INPUT', 'card goes to the configured error channel');
    assert.strictEqual(card.thread_ts, undefined, 'the alert card is top-level, not a reply');
    assert.ok(card.text.includes('bot token path'), 'card fallback text carries the error');
    assert.ok(
      calls.every((c) => !c.url.includes('api.github.com')),
      'no GitHub dispatch'
    );

    // --- 11. Within the throttle window the same agent+signature posts nothing. ---
    alertError({ source: 'agent_workflow', message: 'bot token path', agentId: 'agent-bot' });
    await sleep(30);
    assert.strictEqual(
      calls.filter((c) => c.url.includes('slack.com/api/chat.postMessage')).length,
      1,
      'a repeat inside the throttle window must not post a second card'
    );

    // --- 12. Bot token unset but webhook set → still uses the webhook path ---
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_ERROR_CHANNEL_ID;
    delete process.env.AUTO_RCA_ENABLED;
    process.env.SLACK_ERROR_WEBHOOK_URL = 'https://hooks.slack.test/xxx';
    await __resetAlertThrottleForTests();
    calls.length = 0;
    alertError({ source: 'chat', message: 'webhook fallback still works', agentId: 'w' });
    await sleep(30);
    await waitForCalls(calls, 1);
    assert.strictEqual(calls.length, 1, 'webhook fallback posts one alert');
    assert.strictEqual(
      calls[0].url,
      'https://hooks.slack.test/xxx',
      'uses the webhook, not the API'
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (oldWebhook === undefined) delete process.env.SLACK_ERROR_WEBHOOK_URL;
    else process.env.SLACK_ERROR_WEBHOOK_URL = oldWebhook;
    if (oldBotToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = oldBotToken;
    if (oldChannel === undefined) delete process.env.SLACK_ERROR_CHANNEL_ID;
    else process.env.SLACK_ERROR_CHANNEL_ID = oldChannel;
    if (oldRca === undefined) delete process.env.AUTO_RCA_ENABLED;
    else process.env.AUTO_RCA_ENABLED = oldRca;
    if (oldToken === undefined) delete process.env.GITHUB_DISPATCH_TOKEN;
    else process.env.GITHUB_DISPATCH_TOKEN = oldToken;
  }

  process.stdout.write('error alert emitter test passed\n');
}

run().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.stderr.write('\n');
  process.exit(1);
});
