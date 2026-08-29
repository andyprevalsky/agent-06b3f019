#!/usr/bin/env tsx
/**
 * Unit tests for Report Bug title/prompt helpers + Cursor launch payload shaping
 * + GitHub @cursor (source:scm) launch parsing.
 */

import assert from 'node:assert/strict';
import {
  buildBugReportChatName,
  buildBugReportPrompt,
  buildBugReportSms,
  buildBugReportTitle,
} from '../../domains/agents/reportBugService';
import { launchCursorCloudAgent } from '../../providers/cursorCloudAgents';
import {
  buildGithubCursorIssueBody,
  launchCursorCloudAgentViaGithub,
  parseCursorAgentFromComment,
} from '../../providers/cursorGithubLaunch';

function testTitleShortDescription(): void {
  assert.equal(buildBugReportTitle('Agent stalled on tool call'), 'Agent stalled on tool call');
}

function testTitleTruncatesAtWord(): void {
  const long =
    'The browser agent never completed checkout and kept retrying the same payment step forever';
  const title = buildBugReportTitle(long);
  assert.ok(title.endsWith('…'), 'truncated title ends with ellipsis');
  assert.ok(title.length <= 61, `title length ${title.length}`);
  assert.equal(title.includes('\n'), false);
}

function testChatNamePrefix(): void {
  assert.equal(buildBugReportChatName('checkout hung'), 'Bug | checkout hung');
}

function testPromptIncludesRcaAndAgentId(): void {
  const prompt = buildBugReportPrompt('abc-123', '  It crashed after pause.  ');
  assert.equal(
    prompt,
    '/rca the following bug for agent with ID: [abc-123]\n\nIt crashed after pause.'
  );
}

function testSmsScmMentionsInbox(): void {
  const sms = buildBugReportSms(
    'Bug | stalled checkout',
    'https://cursor.com/agents/bc-abc',
    'scm'
  );
  assert.ok(sms.includes('Bug | stalled checkout'));
  assert.ok(sms.includes('https://cursor.com/agents/bc-abc'));
  assert.ok(sms.includes('source:scm'));
}

function testSmsApiMentionsFilter(): void {
  const sms = buildBugReportSms('Bug | x', 'https://cursor.com/agents/bc-x', 'api');
  assert.ok(sms.toLowerCase().includes('filter'));
}

function testParseCursorAgentFromComment(): void {
  const body =
    'Taking a look!\n\n<a href="https://cursor.com/agents/bc-575ea507-6198-4d37-9590-f99917ac7ca7?cursor_ref=pr_footer">Open</a>';
  const parsed = parseCursorAgentFromComment(body);
  assert.deepEqual(parsed, {
    id: 'bc-575ea507-6198-4d37-9590-f99917ac7ca7',
    url: 'https://cursor.com/agents/bc-575ea507-6198-4d37-9590-f99917ac7ca7',
  });
}

function testGithubIssueBodyMentionsCursor(): void {
  const body = buildGithubCursorIssueBody(
    'Bug | checkout hung',
    '/rca the following bug for agent with ID: [a1]\n\nx'
  );
  assert.ok(body.startsWith('@cursor\n'));
  assert.ok(body.includes('Bug | checkout hung'));
  assert.ok(body.indexOf('Bug | checkout hung') < body.indexOf('/rca'));
  assert.ok(body.includes('[a1]'));
}

async function testLaunchPostsNamedEnvPayload(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedAuth = '';
  let capturedBody: Record<string, unknown> | null = null;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedAuth = String(init?.headers && (init.headers as Record<string, string>).Authorization);
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        agent: {
          id: 'bc-test-1',
          name: 'Bug | stalled',
          url: 'https://cursor.com/agents/bc-test-1',
          status: 'ACTIVE',
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    const result = await launchCursorCloudAgent({
      apiKey: 'key_test',
      baseUrl: 'https://api.cursor.com/v1',
      name: 'Bug | stalled',
      promptText: '/rca the following bug for agent with ID: [a1]\n\nstalled',
      envName: 'rose-ai-labs/rose',
    });
    assert.equal(capturedUrl, 'https://api.cursor.com/v1/agents');
    assert.ok(capturedAuth.startsWith('Basic '), 'uses Basic auth');
    assert.equal(capturedBody?.name, 'Bug | stalled');
    assert.deepEqual(capturedBody?.prompt, {
      text: '/rca the following bug for agent with ID: [a1]\n\nstalled',
    });
    assert.deepEqual(capturedBody?.env, { type: 'cloud', name: 'rose-ai-labs/rose' });
    assert.equal(result.id, 'bc-test-1');
    assert.equal(result.url, 'https://cursor.com/agents/bc-test-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testGithubLaunchPollsForBotComment(): Promise<void> {
  const previousToken = process.env.GITHUB_DISPATCH_TOKEN;
  process.env.GITHUB_DISPATCH_TOKEN = 'ghp_test_token';
  delete process.env.GITHUB_TOKEN;

  let calls = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.endsWith('/issues')) {
      return new Response(
        JSON.stringify({ number: 42, html_url: 'https://github.com/Rose-Ai-Labs/rose/issues/42' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (method === 'POST' && url.includes('/issues/42/comments')) {
      return new Response(JSON.stringify({ id: 1 }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'GET' && url.includes('/issues/42/comments')) {
      return new Response(
        JSON.stringify([
          {
            user: { login: 'cursor[bot]' },
            body: 'Taking a look!\nhttps://cursor.com/agents/bc-scm-probe-1234',
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (method === 'PATCH' && url.includes('/issues/42')) {
      return new Response(JSON.stringify({ state: 'closed' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;

  try {
    const result = await launchCursorCloudAgentViaGithub({
      name: 'Bug | scm probe',
      promptText: '/rca the following bug for agent with ID: [a1]\n\nprobe',
      repo: 'Rose-Ai-Labs/rose',
      fetchImpl,
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      sleep: async () => undefined,
    });
    assert.equal(result.id, 'bc-scm-probe-1234');
    assert.equal(result.url, 'https://cursor.com/agents/bc-scm-probe-1234');
    assert.equal(result.launch_source, 'scm');
    assert.equal(result.github_issue_number, 42);
    assert.ok(calls >= 3, `expected create+poll+close, got ${calls}`);
  } finally {
    if (previousToken === undefined) delete process.env.GITHUB_DISPATCH_TOKEN;
    else process.env.GITHUB_DISPATCH_TOKEN = previousToken;
  }
}

async function main(): Promise<void> {
  const cases: Array<[string, () => void | Promise<void>]> = [
    ['title keeps short descriptions', testTitleShortDescription],
    ['title truncates long descriptions at a word', testTitleTruncatesAtWord],
    ['chat name uses Bug | prefix', testChatNamePrefix],
    ['prompt embeds /rca + agent id', testPromptIncludesRcaAndAgentId],
    ['SMS scm mentions mobile inbox', testSmsScmMentionsInbox],
    ['SMS api mentions Source filter', testSmsApiMentionsFilter],
    ['parse cursor agent url from bot comment', testParseCursorAgentFromComment],
    ['github issue body starts with @cursor', testGithubIssueBodyMentionsCursor],
    ['launch posts named-env Cursor payload', testLaunchPostsNamedEnvPayload],
    ['github launch polls for cursor[bot] link', testGithubLaunchPollsForBotComment],
  ];

  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      failed += 1;
      process.stdout.write(
        `FAIL ${name}: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }
  if (failed > 0) process.exit(1);
}

void main();
