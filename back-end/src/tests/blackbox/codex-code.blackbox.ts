#!/usr/bin/env tsx
import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const DEV_USER_ID = process.env.CODEX_BLACKBOX_USER_ID || '1f85ff25-6e29-4c1b-8739-f917bd101a30';

const ErrorResponse = z.object({ error: z.string() });

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `Expected status ${expected}, got ${actual}: ${JSON.stringify(data).substring(0, 400)}`
    );
  }
}

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown; headers: Headers }> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data, headers: response.headers };
}

function apiKeyHeaders(): Record<string, string> {
  return { 'X-API-Key': API_KEY };
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

async function testCreate_noAuth() {
  const res = await request(`${BASE_URL}/api/codex-code-session/create`, {
    method: 'POST',
    body: JSON.stringify({
      agent_id: crypto.randomUUID(),
      goal: 'test',
      user_id: DEV_USER_ID,
    }),
  });
  assertStatus(res.status, 401, res.data);
  ErrorResponse.parse(res.data);
}

async function testCreate_missingUserId() {
  const res = await request(`${BASE_URL}/api/codex-code-session/create`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({ agent_id: crypto.randomUUID(), goal: 'test' }),
  });
  assertStatus(res.status, 500, res.data);
  ErrorResponse.parse(res.data);
}

async function waitForCodexOutput(
  wsUrl: string,
  timeoutMs = 240_000
): Promise<{ output: string; events: unknown[] }> {
  const WebSocket = (await import('ws')).default;
  let output = '';
  const events: unknown[] = [];
  let connected = false;
  let exitSeen = false;

  return await new Promise<{ output: string; events: unknown[] }>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(
        new Error(
          `Timed out waiting for Codex smoke. connected=${connected}, exit=${exitSeen}, output=${output.slice(-1200)}`
        )
      );
    }, timeoutMs);

    ws.on('open', () => {
      connected = true;
    });
    ws.on('message', (data: Buffer) => {
      const raw = data.toString();
      try {
        const msg = JSON.parse(raw);
        if ((msg.type === 'stdout' || msg.type === 'stderr' || msg.type === 'buffer') && msg.data) {
          output += msg.data;
        }
        if (msg.type === 'code_agent_event' && msg.data) {
          events.push(msg.data);
        }
        if (msg.type === 'code_agent_events' && Array.isArray(msg.data)) {
          events.push(...msg.data);
        }
        if (msg.type === 'exit') {
          exitSeen = true;
          clearTimeout(timeout);
          ws.close();
          resolve({ output, events });
        }
      } catch {
        output += raw;
      }
    });
    ws.on('error', (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
    ws.on('close', () => {
      if (!exitSeen && output.includes('CODEX_E2B_DONE')) {
        clearTimeout(timeout);
        resolve({ output, events });
      }
    });
  });
}

async function testPromptBuilder_sharedContractMentionsOutputRules() {
  const { buildCodeAgentSystemPrompt, CODE_AGENT_INSTRUCTIONS_VERSION } =
    await import('../../providers/codeAgentPrompt');

  const prompt = buildCodeAgentSystemPrompt({
    githubRepoUrl: 'https://github.com/acme/widgets.git',
    workDir: '/home/user/workspace',
  });

  assert(prompt.includes(CODE_AGENT_INSTRUCTIONS_VERSION), 'Prompt version missing');
  assert(prompt.includes('/home/user/attachments'), 'Attachments directory missing');
  assert(prompt.includes('/home/user/output'), 'Output directory missing');
  assert(prompt.includes('Do not return the original attachment path'), 'Transform rule missing');
  assert(
    prompt.includes('Do not launch a separate claude/Claude Code CLI'),
    'Nested Claude CLI guard missing'
  );
  assert(prompt.includes('/home/user/workspace'), 'Repo workDir missing');
}

async function testSmoke_codexCompletesE2bTask() {
  assert(API_KEY !== '', 'BACKEND_API_KEY is required');
  assert(
    process.env.E2B_API_KEY !== undefined && process.env.E2B_API_KEY !== '',
    'E2B_API_KEY is required'
  );
  const agentId = crypto.randomUUID();
  let taskId: string | undefined;
  let sandboxId: string | undefined;

  try {
    const createRes = await request(`${BASE_URL}/api/codex-code-session/create`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        agent_id: agentId,
        user_id: DEV_USER_ID,
        goal: 'Create /home/user/output/codex-smoke.txt containing exactly CODEX_E2B_OK. Then reply with exactly CODEX_E2B_DONE.',
      }),
    });
    assertStatus(createRes.status, 200, createRes.data);

    const body = createRes.data as { ws_url?: string; task_id?: string; sandbox_id?: string };
    assert(!!body.ws_url, 'Missing ws_url');
    assert(!!body.task_id, 'Missing task_id');
    assert(!!body.sandbox_id, 'Missing sandbox_id');
    taskId = body.task_id;
    sandboxId = body.sandbox_id;

    const { output, events } = await waitForCodexOutput(body.ws_url);
    assert(
      output.includes('CODEX_E2B_DONE'),
      `Codex output did not include CODEX_E2B_DONE. Tail: ${output.slice(-1200)}`
    );
    assert(
      events.some((event) => {
        const typed = event as { type?: string; provider?: string };
        return typed.provider === 'codex' && typed.type === 'session';
      }),
      `Expected normalized Codex session event, got: ${JSON.stringify(events).slice(0, 500)}`
    );

    const { Sandbox } = await import('e2b');
    const sandbox = await Sandbox.connect(sandboxId!, { apiKey: process.env.E2B_API_KEY });
    const promptFile = await sandbox.files.read('/home/user/AGENTS.md', { format: 'text' });
    assert(
      String(promptFile).includes('/home/user/output') &&
        String(promptFile).includes('Do not return the original attachment path'),
      `AGENTS.md did not contain shared prompt contract: ${String(promptFile).slice(0, 300)}`
    );
    const fileContent = await sandbox.files.read('/home/user/output/codex-smoke.txt', {
      format: 'text',
    });
    assert(
      String(fileContent).trim() === 'CODEX_E2B_OK',
      `Expected output file sentinel, got: ${String(fileContent).slice(0, 200)}`
    );
  } finally {
    if (taskId) {
      await request(`${BASE_URL}/api/codex-code-session/close`, {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: JSON.stringify({ task_id: taskId }),
      });
    }
  }
}

async function runAll() {
  console.log('Codex Code Session Black-Box Tests\n');
  console.log(`Testing against: ${BASE_URL}\n`);

  const tests: { name: string; fn: () => Promise<void> }[] = [
    { name: 'POST /create -- no auth -> 401', fn: testCreate_noAuth },
    { name: 'POST /create -- missing user_id -> 500', fn: testCreate_missingUserId },
    {
      name: 'prompt -- shared code-agent contract includes output rules',
      fn: testPromptBuilder_sharedContractMentionsOutputRules,
    },
  ];
  if (process.env.BACKEND_CODEX_SMOKE_SKIP === '1') {
    console.log(
      '  SKIP  smoke -- Codex completes task in real E2B sandbox (BACKEND_CODEX_SMOKE_SKIP=1)'
    );
  } else {
    tests.push({
      name: 'smoke -- Codex completes task in real E2B sandbox',
      fn: testSmoke_codexCompletesE2bTask,
    });
  }

  const results: TestResult[] = [];
  for (const test of tests) {
    const result = await runTest(test.name, test.fn);
    results.push(result);
    const icon = result.passed ? '  PASS' : '  FAIL';
    console.log(
      `${icon}  ${result.name}${result.passed ? '' : ` -- ${result.error}`} (${result.duration}ms)`
    );
  }

  const failed = results.filter((r) => !r.passed);
  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) {
    process.exit(1);
  }
  console.log('\nALL CODEX-CODE BLACK-BOX TESTS PASSED\n');
}

runAll().catch((error) => {
  console.error('\nBlack-box test suite crashed:', error);
  process.exit(1);
});
