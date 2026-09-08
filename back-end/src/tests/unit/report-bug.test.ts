#!/usr/bin/env tsx
/**
 * Unit tests for Report Bug title/prompt helpers + Cursor launch payload shaping
 * + GitHub @cursor (source:scm) launch parsing.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBugReportChatName,
  buildBugReportPrompt,
  buildBugReportTitle,
  reportAgentBug,
} from '../../domains/agents/bugReportService';
import { launchCursorCloudAgent } from '../../providers/cursorCloudAgents';
import {
  buildGithubCursorIssueBody,
  isUncertainGithubTransportError,
  launchCursorCloudAgentViaGithub,
  parseCursorAgentFromComment,
  ScmDispatchUnknownError,
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
  assert.equal(buildBugReportChatName('checkout hung'), 'checkout hung');
  // Cursor scm auto-naming strips "Bug |" / "P0" — never force a prefix.
  assert.equal(buildBugReportChatName('Bug | should not double').startsWith('Bug | Bug |'), false);
  assert.equal(buildBugReportChatName('Front page broken').includes('|'), false);
}

function testPromptIncludesRcaAndAgentId(): void {
  const prompt = buildBugReportPrompt('abc-123', '  It crashed after pause.  ');
  assert.equal(
    prompt,
    '/rca the following bug for agent with ID: [abc-123]\nIt crashed after pause.'
  );
  assert.equal(prompt.includes('\n\n'), false, 'no blank line between /rca and description');
  assert.equal(prompt.includes('Launched by Rose'), false);
  assert.equal(prompt.startsWith('Bug |'), false);
}

async function testReportAgentBugDoesNotTextOrRequireSms(): Promise<void> {
  const result = await reportAgentBug(
    '1f85ff25-6e29-4c1b-8739-f917bd101a30',
    'agent-xyz',
    'Checkout never finished',
    {
      findAgentById: async () => ({ agent_id: 'agent-xyz' }) as never,
      launch: async () => ({
        id: 'bc-no-sms',
        name: 'Checkout never finished',
        url: 'https://cursor.com/agents/bc-no-sms',
        launch_source: 'scm',
      }),
    }
  );
  assert.equal(result.success, true);
  assert.equal(result.cursor_agent_id, 'bc-no-sms');
  assert.equal(result.url, 'https://cursor.com/agents/bc-no-sms');
}

function testServiceHasNoSmsSideEffect(): void {
  const sourcePath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../domains/agents/bugReportService.ts'
  );
  const source = readFileSync(sourcePath, 'utf8');
  assert.equal(source.includes('sendSms'), false, 'report-bug must not send SMS');
  assert.equal(source.includes('notifyBugReportSms'), false, 'report-bug must not notify via SMS');
  assert.equal(source.includes('getUserPhone'), false, 'report-bug must not look up a phone');
  assert.equal(source.includes('buildBugReportSms'), false, 'report-bug must not build an SMS body');
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
    '/rca the following bug for agent with ID: [a1]\nEndpoint-path formatting check'
  );
  assert.equal(
    body,
    '@cursor\n\n/rca the following bug for agent with ID: [a1]\nEndpoint-path formatting check'
  );
  assert.equal(body.includes('Launched by Rose'), false);
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
          name: 'stalled',
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
      name: 'stalled',
      promptText: '/rca the following bug for agent with ID: [a1]\n\nstalled',
      envName: 'rose-ai-labs/rose',
    });
    assert.equal(capturedUrl, 'https://api.cursor.com/v1/agents');
    assert.ok(capturedAuth.startsWith('Basic '), 'uses Basic auth');
    assert.equal(capturedBody?.name, 'stalled');
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
  let issueTitle = '';
  let commentBody = '';
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.endsWith('/issues')) {
      const body = JSON.parse(String(init?.body)) as { title?: string };
      issueTitle = body.title ?? '';
      return new Response(
        JSON.stringify({ number: 42, html_url: 'https://github.com/Rose-Ai-Labs/rose/issues/42' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (method === 'POST' && url.includes('/issues/42/comments')) {
      const body = JSON.parse(String(init?.body)) as { body?: string };
      commentBody = body.body ?? '';
      return new Response(JSON.stringify({ id: 1 }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'GET' && url.includes('/issues/42/comments')) {
      return new Response(
        JSON.stringify([
          {
            user: { login: 'cursor-helper' },
            body: 'https://cursor.com/agents/bc-spoofed-should-ignore',
          },
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

  const promptText =
    '/rca the following bug for agent with ID: [a1]\nFE click path verify: Report Bug from Agent Settings';

  try {
    const result = await launchCursorCloudAgentViaGithub({
      name: 'FE click path verify: Report Bug from Agent Settings',
      promptText,
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
    assert.equal(issueTitle, 'FE click path verify: Report Bug from Agent Settings');
    assert.equal(issueTitle.startsWith('Bug |'), false);
    assert.equal(commentBody, `@cursor\n\n${promptText}`);
    assert.equal(commentBody.includes('Launched by Rose'), false);
    assert.equal(commentBody.includes('Bug |'), false);
    assert.ok(calls >= 3, `expected create+poll+close, got ${calls}`);
  } finally {
    if (previousToken === undefined) delete process.env.GITHUB_DISPATCH_TOKEN;
    else process.env.GITHUB_DISPATCH_TOKEN = previousToken;
  }
}

async function testGithubLaunchTimeoutAfterDispatchIsUnknown(): Promise<void> {
  const previousToken = process.env.GITHUB_DISPATCH_TOKEN;
  process.env.GITHUB_DISPATCH_TOKEN = 'ghp_test_token';
  delete process.env.GITHUB_TOKEN;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.endsWith('/issues')) {
      return new Response(
        JSON.stringify({ number: 99, html_url: 'https://github.com/Rose-Ai-Labs/rose/issues/99' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (method === 'POST' && url.includes('/issues/99/comments')) {
      return new Response(JSON.stringify({ id: 1 }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (method === 'GET' && url.includes('/issues/99/comments')) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;

  let now = 1_000;
  const originalNow = Date.now;
  Date.now = () => now;

  try {
    await assert.rejects(
      () =>
        launchCursorCloudAgentViaGithub({
          name: 'timeout probe',
          promptText: '/rca the following bug for agent with ID: [a1]\ntimeout',
          repo: 'Rose-Ai-Labs/rose',
          fetchImpl,
          pollIntervalMs: 1,
          timeoutMs: 5,
          sleep: async () => {
            now += 10;
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof ScmDispatchUnknownError);
        assert.ok(String(error.message).includes('after SCM dispatch'));
        assert.equal(
          (error as ScmDispatchUnknownError).githubIssueUrl,
          'https://github.com/Rose-Ai-Labs/rose/issues/99'
        );
        return true;
      }
    );
  } finally {
    Date.now = originalNow;
    if (previousToken === undefined) delete process.env.GITHUB_DISPATCH_TOKEN;
    else process.env.GITHUB_DISPATCH_TOKEN = previousToken;
  }
}

async function testLaunchPassesAbortSignal(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let sawSignal = false;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sawSignal = init?.signal instanceof AbortSignal;
    return new Response(
      JSON.stringify({
        agent: {
          id: 'bc-test-signal',
          name: 'signal',
          url: 'https://cursor.com/agents/bc-test-signal',
          status: 'ACTIVE',
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    await launchCursorCloudAgent({
      apiKey: 'key_test',
      baseUrl: 'https://api.cursor.com/v1',
      name: 'signal',
      promptText: '/rca the following bug for agent with ID: [a1]\nsignal',
      envName: 'rose-ai-labs/rose',
    });
    assert.equal(sawSignal, true, 'Cursor API fetch must pass AbortSignal');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testGithubCommentTransportFailureIsUnknown(): Promise<void> {
  const previousToken = process.env.GITHUB_DISPATCH_TOKEN;
  process.env.GITHUB_DISPATCH_TOKEN = 'ghp_test_token';
  delete process.env.GITHUB_TOKEN;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.endsWith('/issues')) {
      return new Response(
        JSON.stringify({ number: 77, html_url: 'https://github.com/Rose-Ai-Labs/rose/issues/77' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (method === 'POST' && url.includes('/issues/77/comments')) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        launchCursorCloudAgentViaGithub({
          name: 'transport probe',
          promptText: '/rca the following bug for agent with ID: [a1]\ntransport',
          repo: 'Rose-Ai-Labs/rose',
          fetchImpl,
          pollIntervalMs: 1,
          timeoutMs: 5,
          sleep: async () => undefined,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ScmDispatchUnknownError);
        assert.ok(String(error.message).includes('outcome unknown'));
        return true;
      }
    );
  } finally {
    if (previousToken === undefined) delete process.env.GITHUB_DISPATCH_TOKEN;
    else process.env.GITHUB_DISPATCH_TOKEN = previousToken;
  }
}

function testUncertainTransportClassifier(): void {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(isUncertainGithubTransportError(abort), true);
  assert.equal(isUncertainGithubTransportError(new Error('GitHub API 403: forbidden')), false);
  assert.equal(isUncertainGithubTransportError(new Error('fetch failed')), true);
}

async function testAgentExistsForBugReportArchivedFallback(): Promise<void> {
  const { agentExistsForBugReport } = await import('../../domains/agents/bugReportService');
  assert.equal(
    await agentExistsForBugReport('archived-agent-id', {
      findAgentById: async () => null,
      findAgentAcrossRuns: async (agentId: string) =>
        agentId === 'archived-agent-id'
          ? ({
              run_id: 'run-1',
              agent: { agent_id: agentId },
              messages: [],
              tree: [],
            } as never)
          : null,
    }),
    true
  );
  assert.equal(
    await agentExistsForBugReport('missing-agent-id', {
      findAgentById: async () => null,
      findAgentAcrossRuns: async () => null,
    }),
    false
  );
}

async function main(): Promise<void> {
  const cases: Array<[string, () => void | Promise<void>]> = [
    ['title keeps short descriptions', testTitleShortDescription],
    ['title truncates long descriptions at a word', testTitleTruncatesAtWord],
    ['chat name is plain title without prefix', testChatNamePrefix],
    ['prompt embeds /rca + agent id', testPromptIncludesRcaAndAgentId],
    ['reportAgentBug launches without sending SMS', testReportAgentBugDoesNotTextOrRequireSms],
    ['report-bug service has no SMS side effect', testServiceHasNoSmsSideEffect],
    ['parse cursor agent url from bot comment', testParseCursorAgentFromComment],
    ['github issue body starts with @cursor', testGithubIssueBodyMentionsCursor],
    ['launch posts named-env Cursor payload', testLaunchPostsNamedEnvPayload],
    ['github launch polls for cursor[bot] link', testGithubLaunchPollsForBotComment],
    [
      'github launch timeout after dispatch is ScmDispatchUnknownError',
      testGithubLaunchTimeoutAfterDispatchIsUnknown,
    ],
    [
      'github comment transport failure is ScmDispatchUnknownError',
      testGithubCommentTransportFailureIsUnknown,
    ],
    ['uncertain transport classifier', testUncertainTransportClassifier],
    ['Cursor API launch passes AbortSignal', testLaunchPassesAbortSignal],
    ['archived hub agent counts as reportable', testAgentExistsForBugReportArchivedFallback],
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
