#!/usr/bin/env tsx
/**
 * Black-box contract for POST /api/webhooks/slack/auto-rca.
 *
 * State machine:
 * signed Slack thread reply -> durable GitHub dispatch before HTTP acknowledgement
 * unsigned/root/bot message -> rejected or ignored without side effects
 */
import { createHmac } from 'node:crypto';

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:3001';
const SIGNING_SECRET = 'blackbox-slack-signing-secret';
const CHANNEL = 'C0BE1B87882';
const THREAD_TS = '1784617220.480779';
const MESSAGE_TS = '1784617333.123456';
const EVENT_ID = 'Ev01AUTORCAFEEDBACK';

interface Capture {
  url: string;
  method: string;
  requestBody: string | null;
  captureToken: string | null;
}

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function signature(timestamp: string, body: string): string {
  return `v0=${createHmac('sha256', SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex')}`;
}

async function seedOutbound(url: string, method: string, body: string, responseBody: string) {
  const key = `call:${JSON.stringify([url, method, body])}`;
  const response = await fetch(`${BASE_URL}/api/test/captures/cache`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key,
      value: {
        status: 200,
        statusText: 'OK',
        body: responseBody,
        headers: { 'content-type': 'application/json' },
      },
    }),
  });
  assert(response.ok, `failed to seed outbound fixture: ${response.status}`);
}

async function postSlack(body: string, token: string, valid = true) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return fetch(`${BASE_URL}/api/webhooks/slack/auto-rca`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Capture-Token': token,
      'X-Slack-Request-Timestamp': timestamp,
      'X-Slack-Signature': valid ? signature(timestamp, body) : 'v0=invalid',
    },
    body,
  });
}

async function captures(token: string): Promise<Capture[]> {
  const response = await fetch(`${BASE_URL}/api/test/captures?token=${encodeURIComponent(token)}`);
  const data = (await response.json()) as { captures?: Capture[] };
  return data.captures ?? [];
}

async function waitForCaptures(token: string, count: number): Promise<Capture[]> {
  const deadline = Date.now() + 3000;
  const poll = async (): Promise<Capture[]> => {
    const current = await captures(token);
    if (current.length >= count || Date.now() >= deadline) return current;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return poll();
  };
  return poll();
}

function feedbackEvent(overrides: Record<string, unknown> = {}, eventId = EVENT_ID): string {
  return JSON.stringify({
    token: 'legacy-token-not-trusted',
    team_id: 'T01ROSELABS',
    api_app_id: 'A01ROSELABS',
    type: 'event_callback',
    event_id: eventId,
    event_time: Math.floor(Date.now() / 1000),
    event: {
      type: 'message',
      user: 'U01REVIEWER',
      text: 'Please cover the retry race and preserve the original error.',
      channel: CHANNEL,
      thread_ts: THREAD_TS,
      ts: MESSAGE_TS,
      ...overrides,
    },
  });
}

async function testUrlVerification() {
  const body = JSON.stringify({ type: 'url_verification', challenge: 'challenge-123' });
  const response = await postSlack(body, 'slack-url-verification');
  assert(response.status === 200, `expected 200, got ${response.status}`);
  const data = (await response.json()) as { challenge?: string };
  assert(data.challenge === 'challenge-123', 'Slack challenge was not echoed');
}

async function testInvalidSignature() {
  const token = 'slack-invalid-signature';
  const response = await postSlack(feedbackEvent(), token, false);
  assert(response.status === 401, `expected 401, got ${response.status}`);
  assert((await captures(token)).length === 0, 'unsigned event produced outbound side effects');
}

async function testRootMessageIgnored() {
  const token = 'slack-root-message';
  const response = await postSlack(feedbackEvent({ thread_ts: undefined }), token);
  assert(response.status === 200, `expected 200, got ${response.status}`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert((await captures(token)).length === 0, 'root message was treated as RCA feedback');
}

async function testBotMessageIgnored() {
  const token = 'slack-bot-message';
  const response = await postSlack(feedbackEvent({ bot_id: 'B01ROSEBOT' }), token);
  assert(response.status === 200, `expected 200, got ${response.status}`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert((await captures(token)).length === 0, 'bot reply recursively triggered feedback');
}

async function testDispatchFailureRequestsSlackRetry() {
  const token = 'slack-dispatch-failure';
  const response = await postSlack(feedbackEvent({}, 'Ev01AUTORCAFAILURE'), token);
  assert(response.status === 503, `expected retryable 503, got ${response.status}`);
  const outbound = await waitForCaptures(token, 1);
  assert(
    outbound.some((call) => call.url.includes('/dispatches')),
    'GitHub dispatch was not attempted'
  );
  assert(
    !outbound.some((call) => call.url.includes('/reactions.add')),
    'reviewer was acknowledged before feedback became durable'
  );
}

async function testThreadReplyDispatchesDurably() {
  const token = 'slack-thread-feedback';
  const githubBody = JSON.stringify({
    event_type: 'agent-rca-feedback',
    client_payload: {
      slack_channel: CHANNEL,
      slack_thread_ts: THREAD_TS,
      slack_message_ts: MESSAGE_TS,
      slack_user_id: 'U01REVIEWER',
      slack_event_id: EVENT_ID,
      feedback: 'Please cover the retry race and preserve the original error.',
    },
  });
  await seedOutbound(
    'https://api.github.com/repos/Rose-Ai-Labs/rose/dispatches',
    'POST',
    githubBody,
    ''
  );
  const response = await postSlack(feedbackEvent(), token);
  assert(response.status === 200, `expected 200, got ${response.status}`);
  const outbound = await waitForCaptures(token, 1);
  assert(outbound.length === 1, `expected 1 outbound call, got ${outbound.length}`);
  const dispatch = outbound.find((call) => call.url.includes('/dispatches'));
  assert(
    dispatch?.requestBody === githubBody,
    'GitHub dispatch did not preserve feedback identity'
  );
}

const tests: Array<[string, () => Promise<void>]> = [
  ['signed URL verification', testUrlVerification],
  ['invalid signature rejected', testInvalidSignature],
  ['root channel message ignored', testRootMessageIgnored],
  ['bot thread reply ignored', testBotMessageIgnored],
  ['dispatch failure requests a Slack retry', testDispatchFailureRequestsSlackRetry],
  ['thread feedback durably dispatched before acknowledgement', testThreadReplyDispatchesDurably],
];

async function main(): Promise<void> {
  const results: TestResult[] = [];
  for (const [name, test] of tests) {
    const started = Date.now();
    try {
      await test();
      results.push({ name, passed: true, duration: Date.now() - started });
    } catch (error) {
      results.push({
        name,
        passed: false,
        duration: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const result of results) {
    console.log(`${result.passed ? '✅' : '❌'} ${result.name} (${result.duration}ms)`);
    if (result.error) console.error(`   ${result.error}`);
  }

  if (results.some((result) => !result.passed)) process.exitCode = 1;
}

void main();
