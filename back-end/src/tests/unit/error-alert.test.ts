#!/usr/bin/env tsx

import assert from 'node:assert';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  const oldRepo = process.env.GITHUB_DISPATCH_REPO;

  // The bot-token path resolves through the Slack Web API; every other suite runs
  // through the webhook path, so keep the bot env unset unless a case opts in.
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_ERROR_CHANNEL_ID;

  const calls: Captured[] = [];
  let failNext = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (failNext) {
      failNext = false;
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
    __resetAlertThrottleForTests();
    calls.length = 0;

    alertError({
      source: 'agent_workflow',
      message: 'db pool timeout after 42ms',
      agentId: 'agent-abc',
    });
    await sleep(30);
    assert.strictEqual(calls.length, 1, 'should post exactly one Slack alert');
    assert.strictEqual(calls[0].url, 'https://hooks.slack.test/xxx', 'posts to the webhook url');
    const payload = calls[0].body as { text: string; blocks: unknown[] };
    assert.ok(payload.text.includes('db pool timeout'), 'payload carries the message');
    assert.ok(Array.isArray(payload.blocks) && payload.blocks.length >= 3, 'payload has blocks');

    // --- 2. Identical signature within the window is throttled (deduped) ---
    calls.length = 0;
    alertError({
      source: 'agent_workflow',
      message: 'db pool timeout after 42ms',
      agentId: 'agent-def',
    });
    await sleep(30);
    assert.strictEqual(calls.length, 0, 'duplicate signature must be throttled');

    // Signatures normalize out UUIDs/numbers, so a message differing ONLY by a
    // number is the same signature and stays throttled.
    alertError({ source: 'agent_workflow', message: 'db pool timeout after 9001ms', agentId: 'x' });
    await sleep(30);
    assert.strictEqual(calls.length, 0, 'number-only difference collapses to the same signature');

    // --- 3. A genuinely different signature alerts again ---
    calls.length = 0;
    alertError({ source: 'sms', message: 'totally different failure', userId: 'u1' });
    await sleep(30);
    assert.strictEqual(calls.length, 1, 'distinct signature should alert');

    // --- 4. No webhook configured → no fetch, no throw ---
    delete process.env.SLACK_ERROR_WEBHOOK_URL;
    __resetAlertThrottleForTests();
    calls.length = 0;
    alertError({ source: 'chat', message: 'no webhook here', agentId: 'a' });
    await sleep(30);
    assert.strictEqual(calls.length, 0, 'no webhook → no outbound call');

    // --- 5. Never throws even when fetch rejects ---
    process.env.SLACK_ERROR_WEBHOOK_URL = 'https://hooks.slack.test/xxx';
    __resetAlertThrottleForTests();
    calls.length = 0;
    failNext = true;
    alertError({ source: 'chat', message: 'fetch will reject', agentId: 'a' });
    await sleep(30); // if this throws unhandled, the process crashes → test fails

    // --- 6. AUTO_RCA_ENABLED=1 with an agentId fires the GitHub dispatch ---
    process.env.AUTO_RCA_ENABLED = '1';
    process.env.GITHUB_DISPATCH_TOKEN = 'ghp_test';
    process.env.GITHUB_DISPATCH_REPO = 'Rose-Ai-Labs/rose';
    __resetAlertThrottleForTests();
    calls.length = 0;
    alertError({ source: 'agent_workflow', message: 'rca please', agentId: 'agent-rca' });
    await sleep(30);
    const dispatch = calls.find((c) => c.url.includes('api.github.com'));
    assert.ok(dispatch !== undefined, 'AUTO_RCA_ENABLED should fire a repository_dispatch');
    const dispatchBody = dispatch.body as {
      event_type: string;
      client_payload: { agent_id: string };
    };
    assert.strictEqual(
      dispatchBody.event_type,
      'agent-failure',
      'dispatch uses agent-failure event'
    );
    assert.strictEqual(
      dispatchBody.client_payload.agent_id,
      'agent-rca',
      'dispatch carries the agent id'
    );

    // --- 7. Flag off → never dispatches RCA ---
    delete process.env.AUTO_RCA_ENABLED;
    __resetAlertThrottleForTests();
    calls.length = 0;
    alertError({ source: 'agent_workflow', message: 'no rca', agentId: 'agent-x' });
    await sleep(30);
    assert.ok(
      calls.every((c) => !c.url.includes('api.github.com')),
      'flag off → no RCA dispatch'
    );

    // --- 8. RCA flag on but no token → Slack still sent, no GitHub dispatch, no throw ---
    process.env.AUTO_RCA_ENABLED = '1';
    delete process.env.GITHUB_DISPATCH_TOKEN;
    __resetAlertThrottleForTests();
    calls.length = 0;
    alertError({ source: 'agent_workflow', message: 'rca but no token', agentId: 'agent-y' });
    await sleep(30);
    assert.strictEqual(calls.length, 1, 'Slack alert still fires without a dispatch token');
    assert.ok(!calls[0].url.includes('api.github.com'), 'missing token → no repository_dispatch');

    // --- 9. Slack non-2xx is handled without throwing ---
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    delete process.env.AUTO_RCA_ENABLED;
    __resetAlertThrottleForTests();
    alertError({ source: 'sms', message: 'slack rejects this one', userId: 'u2' });
    await sleep(30); // must not throw despite the 500

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

    // --- 10. Bot token + channel → posts via chat.postMessage; the RCA dispatch
    //         carries the message handle (ts + channel) for the lifecycle card ---
    delete process.env.SLACK_ERROR_WEBHOOK_URL;
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_ERROR_CHANNEL_ID = 'C_INPUT';
    process.env.AUTO_RCA_ENABLED = '1';
    process.env.GITHUB_DISPATCH_TOKEN = 'ghp_test';
    __resetAlertThrottleForTests();
    calls.length = 0;
    alertError({ source: 'agent_workflow', message: 'bot token path', agentId: 'agent-bot' });
    await sleep(30);
    const slackPost = calls.find((c) => c.url.includes('slack.com/api/chat.postMessage'));
    assert.ok(slackPost !== undefined, 'bot token → posts via chat.postMessage');
    assert.strictEqual(
      (slackPost.body as { channel: string }).channel,
      'C_INPUT',
      'chat.postMessage targets the configured channel'
    );
    const botDispatch = calls.find((c) => c.url.includes('api.github.com'));
    assert.ok(botDispatch !== undefined, 'flag on → dispatch fires');
    const botPayload = (botDispatch.body as { client_payload: Record<string, string> })
      .client_payload;
    assert.strictEqual(botPayload.slack_ts, '1700000000.000100', 'dispatch carries the message ts');
    assert.strictEqual(
      botPayload.slack_channel,
      'C_TEST',
      'dispatch carries the resolved channel from the Slack response'
    );

    // --- 11. Bot token unset but webhook set → still uses the webhook path ---
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_ERROR_CHANNEL_ID;
    delete process.env.AUTO_RCA_ENABLED;
    process.env.SLACK_ERROR_WEBHOOK_URL = 'https://hooks.slack.test/xxx';
    __resetAlertThrottleForTests();
    calls.length = 0;
    alertError({ source: 'chat', message: 'webhook fallback still works', agentId: 'w' });
    await sleep(30);
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
    if (oldRepo === undefined) delete process.env.GITHUB_DISPATCH_REPO;
    else process.env.GITHUB_DISPATCH_REPO = oldRepo;
  }

  process.stdout.write('error alert emitter test passed\n');
}

run().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.stack || error.message : String(error));
  process.stderr.write('\n');
  process.exit(1);
});
