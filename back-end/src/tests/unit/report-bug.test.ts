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
  BUG_REPORT_SCREENSHOT_URL_TTL_SECONDS,
  ReportBugForbiddenError,
  ReportBugValidationError,
  uploadBugReportScreenshot,
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
  const recorded: Array<[string, string]> = [];
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
      recordReport: async (agentId, runId) => {
        recorded.push([agentId, runId]);
      },
    }
  );
  assert.deepEqual(
    recorded,
    [['agent-xyz', 'run-no-sms']],
    'manual report marks the agent reported'
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

async function testManualReportRecordFailureKeepsLaunchResult(): Promise<void> {
  const result = await reportAgentBug(
    '1f85ff25-6e29-4c1b-8739-f917bd101a30',
    'agent-record-down',
    'Stalled on checkout',
    {
      findAgentById: async () => ({ agent_id: 'agent-record-down' }) as never,
      launch: async () => ({ run_id: 'run-record-down', name: 'n', url: 'https://boxes.dev/x' }),
      recordReport: async () => {
        throw new Error('db down');
      },
    }
  );
  assert.equal(result.run_id, 'run-record-down');
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
      // Shape observed from the live API on 2026-10-09 (tar_3e6b90197e3c487d8edd116b).
      {
        runPublicId: 'tar_123',
        backend: 'claude',
        status: 'starting',
        statusUrl: `${RUN_URL}s/tar_123`,
        effective: {
          promptSource: 'api_request',
          threadTitle: 'stalled (server)',
          backend: 'claude',
          model: 'claude-opus-5-5',
          reasoningEffort: 'xhigh',
          serviceTier: null,
        },
        statusReasonCode: null,
        statusReasonMessage: null,
        startupAttemptPhase: 'provisioning_execution',
        hasChildThread: true,
        clientThreadId: 'client-thread-1',
        devboxId: null,
        backendThreadId: null,
        threadReadyAt: null,
        idempotentReplay: false,
        requestId: 'req-1',
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
    runId: 'tar_123',
    statusUrl: `${RUN_URL}s/tar_123`,
    threadTitle: 'stalled (server)',
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
        // A legacy/guessed `runId` key is not the contract; only runPublicId counts.
        fetchImpl: captureFetch(202, { runId: 'tar_wrong_key', status: 'starting' }, []),
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

const ADMIN_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const PNG_BYTES = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('0000000d49484452', 'hex'),
]);

function screenshotDeps(calls: { stored: unknown[]; signed: unknown[] }) {
  return {
    findAgentById: async () => ({ agent_id: 'agent-xyz' }) as never,
    store: async (userId: string, buffer: Buffer, filename: string, mimeType: string) => {
      calls.stored.push({ userId, size: buffer.length, filename, mimeType });
      return {
        id: 'file-1',
        storage_path: `${userId}/file-1_${filename}`,
        original_filename: filename,
        mime_type: mimeType,
        size_bytes: buffer.length,
        created_at: '2026-10-09T00:00:00.000Z',
      };
    },
    sign: async (storagePath: string, expiresIn: number) => {
      calls.signed.push({ storagePath, expiresIn });
      return `https://storage.example/sign/attachments/${storagePath}?token=t`;
    },
  };
}

async function testScreenshotStoresAndSignsForSevenDays(): Promise<void> {
  const calls = { stored: [] as unknown[], signed: [] as unknown[] };
  const result = await uploadBugReportScreenshot(
    ADMIN_USER_ID,
    'agent-xyz',
    { buffer: PNG_BYTES, originalname: 'live-view.png', mimetype: 'image/png' },
    screenshotDeps(calls)
  );
  assert.equal(BUG_REPORT_SCREENSHOT_URL_TTL_SECONDS, 604_800);
  assert.deepEqual(calls.stored, [
    {
      userId: ADMIN_USER_ID,
      size: PNG_BYTES.length,
      filename: 'live-view.png',
      mimeType: 'image/png',
    },
  ]);
  assert.deepEqual(calls.signed, [
    { storagePath: `${ADMIN_USER_ID}/file-1_live-view.png`, expiresIn: 604_800 },
  ]);
  assert.deepEqual(result, {
    success: true,
    name: 'live-view.png',
    url: `https://storage.example/sign/attachments/${ADMIN_USER_ID}/file-1_live-view.png?token=t`,
    expires_in: 604_800,
  });
}

async function testScreenshotRequiresAdminBeforeStoring(): Promise<void> {
  const calls = { stored: [] as unknown[], signed: [] as unknown[] };
  await assert.rejects(
    uploadBugReportScreenshot(
      'not-an-admin',
      'agent-xyz',
      { buffer: PNG_BYTES, originalname: 'x.png', mimetype: 'image/png' },
      screenshotDeps(calls)
    ),
    ReportBugForbiddenError
  );
  assert.deepEqual(calls.stored, []);
}

async function testScreenshotRejectsNonImages(): Promise<void> {
  const calls = { stored: [] as unknown[], signed: [] as unknown[] };
  const deps = screenshotDeps(calls);
  for (const file of [
    { buffer: Buffer.from('plain text'), originalname: 'notes.txt', mimetype: 'text/plain' },
    // Declared PNG whose bytes are an HTML error page (proxy/dev-server interception).
    { buffer: Buffer.from('<!doctype html><html>'), originalname: 'x.png', mimetype: 'image/png' },
    // Not an image type at all, even though the key exists on Object.prototype.
    { buffer: PNG_BYTES, originalname: 'x.png', mimetype: 'constructor' },
    undefined,
  ]) {
    await assert.rejects(
      uploadBugReportScreenshot(ADMIN_USER_ID, 'agent-xyz', file, deps),
      ReportBugValidationError
    );
  }
  assert.deepEqual(calls.stored, []);
}

async function main(): Promise<void> {
  const cases: Array<[string, () => void | Promise<void>]> = [
    ['title keeps short descriptions', testTitleShortDescription],
    ['title truncates long descriptions at a word', testTitleTruncatesAtWord],
    ['chat name is plain title without prefix', testChatNamePrefix],
    ['prompt embeds /rca + agent id', testPromptIncludesRcaAndAgentId],
    ['reportAgentBug launches without sending SMS', testReportAgentBugDoesNotTextOrRequireSms],
    ['report-bug service has no SMS side effect', testServiceHasNoSmsSideEffect],
    [
      'manual report record failure keeps the launch result',
      testManualReportRecordFailureKeepsLaunchResult,
    ],
    ['idempotency key is stable per agent + description', testIdempotencyKeyIsStablePerReport],
    ['default launch requires the boxes.dev secret', testDefaultLaunchRequiresBoxesSecret],
    ['boxes.dev run posts configurable request', testBoxesRunPostsConfigurableRequest],
    ['boxes.dev rejection surfaces error code', testBoxesRunRejectionSurfacesErrorCode],
    ['boxes.dev 202 without run id fails loudly', testBoxesRunWithoutRunIdFailsLoudly],
    ['archived hub agent counts as reportable', testAgentExistsForBugReportArchivedFallback],
    ['screenshot is stored and signed for seven days', testScreenshotStoresAndSignsForSevenDays],
    ['screenshot upload requires admin before storing', testScreenshotRequiresAdminBeforeStoring],
    ['screenshot upload rejects non-images', testScreenshotRejectsNonImages],
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
