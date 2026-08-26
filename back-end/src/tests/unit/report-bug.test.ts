#!/usr/bin/env tsx
/**
 * Unit tests for Report Bug title/prompt helpers + Cursor launch payload shaping.
 */

import assert from 'node:assert/strict';
import {
  buildBugReportChatName,
  buildBugReportPrompt,
  buildBugReportSms,
  buildBugReportTitle,
} from '../../domains/agents/reportBugService';
import { launchCursorCloudAgent } from '../../providers/cursorCloudAgents';

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

function testSmsIncludesDeepLink(): void {
  const sms = buildBugReportSms(
    'Bug | stalled checkout',
    'https://cursor.com/agents/bc-abc'
  );
  assert.ok(sms.includes('Bug | stalled checkout'));
  assert.ok(sms.includes('https://cursor.com/agents/bc-abc'));
  assert.ok(sms.toLowerCase().includes('rose inbox'));
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

async function main(): Promise<void> {
  const cases: Array<[string, () => void | Promise<void>]> = [
    ['title keeps short descriptions', testTitleShortDescription],
    ['title truncates long descriptions at a word', testTitleTruncatesAtWord],
    ['chat name uses Bug | prefix', testChatNamePrefix],
    ['prompt embeds /rca + agent id', testPromptIncludesRcaAndAgentId],
    ['SMS includes Cursor deep link + inbox note', testSmsIncludesDeepLink],
    ['launch posts named-env Cursor payload', testLaunchPostsNamedEnvPayload],
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
