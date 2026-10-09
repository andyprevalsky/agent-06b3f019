#!/usr/bin/env tsx
/**
 * Unit tests for Report Bug title/prompt helpers + boxes.dev automation run
 * request shaping and response parsing.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBugReportChatName,
  buildBugReportIdempotencyKey,
  buildBugReportPrompt,
  buildBugReportTitle,
  ReportBugNotConfiguredError,
  reportAgentBug,
  type ReportBugLaunchArgs,
} from '../../domains/agents/bugReportService';
import { runBoxesThreadAutomation } from '../../providers/boxesThreadAutomations';

const RUN_URL = 'https://api.boxes.dev/v1/thread-automations/ta_test/run';

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
  // Never force a "Bug |" / "P0" prefix onto the thread title.
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
  let launchArgs: ReportBugLaunchArgs | null = null;
  const result = await reportAgentBug(
    '1f85ff25-6e29-4c1b-8739-f917bd101a30',
    'agent-xyz',
    '  Checkout never finished  ',
    {
      findAgentById: async () => ({ agent_id: 'agent-xyz' }) as never,
      launch: async (args) => {
        launchArgs = args;
        return {
          run_id: 'run-no-sms',
          name: 'Checkout never finished',
          url: 'https://boxes.dev/open/desktop?box=rose&automation=ta_test',
        };
      },
    }
  );
  assert.deepEqual(result, {
    success: true,
    name: 'Checkout never finished',
    url: 'https://boxes.dev/open/desktop?box=rose&automation=ta_test',
    run_id: 'run-no-sms',
  });
  assert.deepEqual(launchArgs, {
    name: 'Checkout never finished',
    promptText: '/rca the following bug for agent with ID: [agent-xyz]\nCheckout never finished',
    idempotencyKey: buildBugReportIdempotencyKey('agent-xyz', 'Checkout never finished'),
  });
}

function testIdempotencyKeyIsStablePerReport(): void {
  const key = buildBugReportIdempotencyKey('agent-1', 'stalled on checkout');
  assert.equal(key, buildBugReportIdempotencyKey('agent-1', '  stalled on checkout\n'));
  assert.notEqual(key, buildBugReportIdempotencyKey('agent-2', 'stalled on checkout'));
  assert.notEqual(key, buildBugReportIdempotencyKey('agent-1', 'stalled on payment'));
  assert.equal(key.includes('stalled'), false, 'key must not leak incident text');
}

async function testDefaultLaunchRequiresBoxesSecret(): Promise<void> {
  const previous = process.env.BOXES_BUG_REPORT_SECRET;
  process.env.BOXES_BUG_REPORT_SECRET = '  ';
  try {
    await assert.rejects(
      () =>
        reportAgentBug('1f85ff25-6e29-4c1b-8739-f917bd101a30', 'agent-xyz', 'unconfigured', {
          findAgentById: async () => ({ agent_id: 'agent-xyz' }) as never,
        }),
      ReportBugNotConfiguredError
    );
  } finally {
    if (previous === undefined) delete process.env.BOXES_BUG_REPORT_SECRET;
    else process.env.BOXES_BUG_REPORT_SECRET = previous;
  }
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
  assert.equal(
    source.includes('buildBugReportSms'),
    false,
    'report-bug must not build an SMS body'
  );
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: unknown;
}

function captureFetch(
  status: number,
  responseBody: unknown,
  captured: CapturedRequest[]
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body)) as unknown,
      signal: init?.signal,
    });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

async function testBoxesRunPostsConfigurableRequest(): Promise<void> {
  const captured: CapturedRequest[] = [];
  const result = await runBoxesThreadAutomation({
    runUrl: RUN_URL,
    secret: 'tas_test_secret',
    prompt: '/rca the following bug for agent with ID: [a1]\nstalled',
    threadTitle: 'stalled',
    idempotencyKey: 'rose-report-bug-abc',
    fetchImpl: captureFetch(
      202,
      {
        runId: 'run_123',
        statusUrl: `${RUN_URL}s/run_123`,
        devboxId: null,
        threadTitle: 'stalled',
      },
      captured
    ),
  });
  assert.equal(captured.length, 1);
  const [request] = captured;
  assert.equal(request.url, RUN_URL);
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.Authorization, 'Bearer tas_test_secret');
  assert.equal(request.headers['Idempotency-Key'], 'rose-report-bug-abc');
  // Only prompt + threadTitle: saved execution defaults and a fresh devbox apply.
  assert.deepEqual(request.body, {
    prompt: '/rca the following bug for agent with ID: [a1]\nstalled',
    threadTitle: 'stalled',
  });
  assert.ok(request.signal instanceof AbortSignal, 'boxes.dev fetch must pass AbortSignal');
  assert.deepEqual(result, {
    runId: 'run_123',
    statusUrl: `${RUN_URL}s/run_123`,
    threadTitle: 'stalled',
  });
}

async function testBoxesRunRejectionSurfacesErrorCode(): Promise<void> {
  await assert.rejects(
    () =>
      runBoxesThreadAutomation({
        runUrl: RUN_URL,
        secret: 'tas_test_secret',
        prompt: 'p',
        threadTitle: 't',
        idempotencyKey: 'k',
        fetchImpl: captureFetch(
          409,
          { error: 'automation_paused', message: 'This automation is paused.' },
          []
        ),
      }),
    /boxes\.dev API 409: automation_paused: This automation is paused\./
  );
}

async function testBoxesRunWithoutRunIdFailsLoudly(): Promise<void> {
  await assert.rejects(
    () =>
      runBoxesThreadAutomation({
        runUrl: RUN_URL,
        secret: 'tas_test_secret',
        prompt: 'p',
        threadTitle: 't',
        idempotencyKey: 'k',
        fetchImpl: captureFetch(202, { accepted: true }, []),
      }),
    /accepted the run but returned no run id/
  );
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
    ['idempotency key is stable per agent + description', testIdempotencyKeyIsStablePerReport],
    ['default launch requires the boxes.dev secret', testDefaultLaunchRequiresBoxesSecret],
    ['boxes.dev run posts configurable request', testBoxesRunPostsConfigurableRequest],
    ['boxes.dev rejection surfaces error code', testBoxesRunRejectionSurfacesErrorCode],
    ['boxes.dev 202 without run id fails loudly', testBoxesRunWithoutRunIdFailsLoudly],
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
