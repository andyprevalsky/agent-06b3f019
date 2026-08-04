#!/usr/bin/env tsx
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { resolveCodexCodeAuthEnvs } from '../../providers/e2b';
import { prisma } from '../../providers/database';
import { testPersistOutput_coolsExhaustedOAuthCredential } from './codex-code-oauth-feedback.case';
import {
  CredentialExhaustionSkip,
  codexSmokeCreditSkipReason,
  testCreditExhaustion_neverOverridesSuccessSentinel,
  testDetectCreditExhaustion_negative,
  testDetectCreditExhaustion_observedOpenAiWording,
  testDetectCreditExhaustion_positive,
} from './codex-credit-skip';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const DEV_USER_ID = process.env.CODEX_BLACKBOX_USER_ID || '1f85ff25-6e29-4c1b-8739-f917bd101a30';

const ErrorResponse = z.object({ error: z.string() });

interface TestResult {
  name: string;
  passed: boolean;
  skipped?: boolean;
  skipReason?: string;
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
    if (error instanceof CredentialExhaustionSkip) {
      // Not a failure: the third-party account is out of credits/quota. Report
      // as a loud SKIP so the deploy gate is not blocked by external funding.
      return {
        name,
        passed: true,
        skipped: true,
        skipReason: error.message,
        duration: Date.now() - start,
      };
    }
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
): Promise<{ output: string; events: unknown[]; exitCode?: number }> {
  const WebSocket = (await import('ws')).default;
  let output = '';
  const events: unknown[] = [];
  let connected = false;
  let exitSeen = false;

  return await new Promise<{ output: string; events: unknown[]; exitCode?: number }>(
    (resolve, reject) => {
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
          if (
            (msg.type === 'stdout' || msg.type === 'stderr' || msg.type === 'buffer') &&
            msg.data
          ) {
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
            resolve({
              output,
              events,
              exitCode: typeof msg.code === 'number' ? msg.code : undefined,
            });
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
    }
  );
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
  assert(
    prompt.includes('Files outside this directory are not returned to the user'),
    'Output directory return contract missing'
  );
  assert(
    prompt.includes('verify each requested artifact exists in /home/user/output'),
    'Output artifact verification rule missing'
  );
  assert(prompt.includes('Do not return the original attachment path'), 'Transform rule missing');
  assert(
    prompt.includes('Do not launch a separate claude/Claude Code CLI'),
    'Nested Claude CLI guard missing'
  );
  assert(prompt.includes('/home/user/workspace'), 'Repo workDir missing');
}

async function testTemplate_pinsCodexCliForGpt56() {
  const dockerfile = readFileSync(
    join(process.cwd(), '..', 'e2b-templates', 'codex-code', 'e2b.Dockerfile'),
    'utf8'
  );
  assert(
    dockerfile.includes('ARG CODEX_VERSION=0.144.1') &&
      dockerfile.includes('npm install -g "@openai/codex@$CODEX_VERSION"') &&
      !dockerfile.includes('ubuntu.mirror.constant.com'),
    'Codex E2B template must pin the GPT-5.6-compatible Codex CLI and use reliable Ubuntu sources'
  );
}

async function testRuntimeFallback_recognizesRevokedOAuthRefreshToken() {
  const wsServer = readFileSync(
    join(process.cwd(), '..', 'e2b-templates', 'codex-code', 'ws-server.mjs'),
    'utf8'
  );
  assert(
    wsServer.includes('refresh_token_invalidated') &&
      wsServer.includes('oauth_refresh_invalid') &&
      wsServer.includes('oauthFallbackReason ??= classifyOAuthFallbackReason(message)'),
    'Codex ws-server must classify revoked refresh tokens for funded-key fallback'
  );
}

// ── resolveCodexCodeAuthEnvs (pure auth-env selection) ───────────────────────
// The sandbox ws-server logs in with CODEX_AUTH_JSON (OAuth) when present, else
// `codex login --with-api-key` using OPENAI_API_KEY. These assert the backend
// actually hands the sandbox one of those — so a rate-limited Codex OAuth token
// (fetchGptCodeCredentialsWithMeta returns null) falls back to the funded key
// instead of throwing, which is why the deploy Codex smoke used to stall.
const CODEX_OAUTH_META = {
  accessToken: 'sk-codex-oat-xxx',
  accountId: 'acct_123',
  source: 'pool',
  userId: 'u1',
  poolTokenId: 'p1',
  credentials: '{"tokens":{"access_token":"a","refresh_token":"r"}}',
} as unknown as Parameters<typeof resolveCodexCodeAuthEnvs>[0];

function testResolveCodexAuthEnvs_oauthPrimaryWithApiKeyRuntimeFallback() {
  const envs = resolveCodexCodeAuthEnvs(CODEX_OAUTH_META, 'sk-proj-funded-key');
  assert(
    envs.CODEX_AUTH_JSON === '{"tokens":{"access_token":"a","refresh_token":"r"}}',
    'CODEX_AUTH_JSON set (primary) when OAuth credential present'
  );
  // Injected ALONGSIDE the OAuth token so the sandbox can re-login + retry if the
  // OAuth token hits usage_limit_reached mid-run (the real deploy-stall failure).
  assert(
    envs.OPENAI_API_KEY === 'sk-proj-funded-key',
    'funded key injected alongside OAuth token as a runtime fallback'
  );
}

function testResolveCodexAuthEnvs_oauthWithoutFundedKey() {
  const envs = resolveCodexCodeAuthEnvs(CODEX_OAUTH_META, undefined);
  assert(
    envs.CODEX_AUTH_JSON === '{"tokens":{"access_token":"a","refresh_token":"r"}}',
    'CODEX_AUTH_JSON set when OAuth credential present and no funded key'
  );
  assert(envs.OPENAI_API_KEY === undefined, 'no OPENAI_API_KEY when funded key is not configured');
}

function testResolveCodexAuthEnvs_apiKeyFallback() {
  const envs = resolveCodexCodeAuthEnvs(null, 'sk-proj-funded-key');
  assert(
    envs.OPENAI_API_KEY === 'sk-proj-funded-key',
    'falls back to OPENAI_API_KEY when no OAuth credential (e.g. token rate-limited/exhausted)'
  );
  assert(envs.CODEX_AUTH_JSON === undefined, 'no OAuth auth.json in fallback');
}

function testResolveCodexAuthEnvs_noCredsNoKeyThrows() {
  let threw = false;
  try {
    resolveCodexCodeAuthEnvs(null, undefined);
  } catch {
    threw = true;
  }
  assert(threw, 'throws when no OAuth credential and no OPENAI_API_KEY fallback configured');
}

function testResolveCodexAuthEnvs_emptyKeyThrows() {
  let threw = false;
  try {
    resolveCodexCodeAuthEnvs(null, '');
  } catch {
    threw = true;
  }
  assert(threw, 'throws when the api-key fallback is an empty string');
}

function testResolveCodexAuthEnvs_cooldownExcludesFundedKey() {
  const oauthEnvs = resolveCodexCodeAuthEnvs(CODEX_OAUTH_META, 'sk-proj-funded-key', true);
  assert(
    oauthEnvs.CODEX_AUTH_JSON !== undefined && oauthEnvs.OPENAI_API_KEY === undefined,
    'cooled funded key must be withheld while a usable OAuth credential remains'
  );

  let threw = false;
  try {
    resolveCodexCodeAuthEnvs(null, 'sk-proj-funded-key', true);
  } catch {
    threw = true;
  }
  assert(threw, 'cooled funded key must not launch an API-key-only Codex sandbox');
}

async function testPersistOutput_coolsBothCredentialsAfterFailedFallback() {
  const userId = crypto.randomUUID();
  const integration = await prisma.integration.create({
    data: {
      userId,
      name: 'gpt_code',
      type: 'TOOL_SETUP',
      status: 'CONNECTED',
      isActive: true,
    },
  });
  const taskId = crypto.randomUUID();
  await prisma.claudeCodeSession.create({
    data: {
      id: taskId,
      agentId: crypto.randomUUID(),
      sandboxId: `codex-funded-exhaustion-${taskId}`,
      goal: 'captured Codex OAuth-to-funded-key exhaustion replay',
      status: 'ACTIVE',
      claudeTokenSource: 'user',
      claudeTokenIntegrationId: integration.id,
    },
  });

  try {
    const output =
      Array.from({ length: 650 }, (_, index) => `normal fallback output ${index}`).join('\n') +
      '\n[Codex] Error code: insufficient_quota\n';
    const res = await request(`${BASE_URL}/api/codex-code-session/${taskId}/output`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        output,
        credential_feedback: [
          {
            source: 'oauth',
            reason: 'Quota exceeded. Check your plan and billing details.',
          },
          { source: 'funded_api_key', reason: 'insufficient_quota' },
        ],
      }),
    });
    assertStatus(res.status, 200, res.data);

    const persistedIntegration = await prisma.integration.findUnique({
      where: { id: integration.id },
    });
    assert(
      persistedIntegration?.rateLimitedUntil instanceof Date &&
        persistedIntegration.rateLimitedUntil.getTime() > Date.now(),
      'failed OAuth-to-funded-key fallback must cool the exact selected OAuth integration'
    );

    const cooldown = await prisma.integration.findUnique({
      where: {
        userId_name: {
          userId: '00000000-0000-0000-0000-000000000000',
          name: 'gpt_api_key_cooldown',
        },
      },
    });
    assert(
      cooldown?.rateLimitedUntil instanceof Date &&
        cooldown.rateLimitedUntil.getTime() > Date.now(),
      'failed OAuth-to-funded-key fallback must cool the shared funded credential'
    );
  } finally {
    await prisma.claudeCodeSession.deleteMany({ where: { id: taskId } });
    await prisma.integration.deleteMany({ where: { id: integration.id } });
    await prisma.integration.deleteMany({
      where: {
        userId: '00000000-0000-0000-0000-000000000000',
        name: 'gpt_api_key_cooldown',
      },
    });
  }
}

async function testPersistOutput_rejectsInvalidCredentialFeedback() {
  const res = await request(`${BASE_URL}/api/codex-code-session/${crypto.randomUUID()}/output`, {
    method: 'POST',
    headers: apiKeyHeaders(),
    body: JSON.stringify({
      output: 'terminal output',
      credential_feedback: [{ source: 'funded_api_key', reason: '' }],
    }),
  });
  assertStatus(res.status, 400, res.data);
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

    const { output, events, exitCode } = await waitForCodexOutput(body.ws_url);
    const outputRes = await request(`${BASE_URL}/api/codex-code-session/${taskId}/output`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ output }),
    });
    assertStatus(outputRes.status, 200, outputRes.data);
    // Before treating a missing sentinel as a hard failure, check whether the
    // run simply ran out of credits on EVERY credential path (OAuth + funded
    // key). That is an external funding state, not a code regression, so it is
    // a deploy-approved SKIP rather than a FAIL.
    const creditSkip = codexSmokeCreditSkipReason(output, events);
    if (creditSkip) {
      throw new CredentialExhaustionSkip(
        `Codex credentials exhausted (out of credits/quota) on all paths; smoke SKIPPED without failing the deploy gate. Signal: ${creditSkip}. exit=${exitCode ?? 'unknown'}`
      );
    }
    assert(
      output.includes('CODEX_E2B_DONE'),
      `Codex output did not include CODEX_E2B_DONE. exit=${exitCode ?? 'unknown'} events=${JSON.stringify(events).slice(-800)} Tail: ${output.slice(-1200)}`
    );
    assert(
      events.some((event) => {
        const typed = event as { type?: string; provider?: string };
        return typed.provider === 'codex' && typed.type === 'session';
      }),
      `Expected normalized Codex session event, got: ${JSON.stringify(events).slice(0, 500)}`
    );

    // Runtime-fallback invariant: if the ChatGPT OAuth token hit its usage limit
    // or proved revoked mid-run, the sandbox MUST re-login with the funded key
    // (auth_fallback event) rather than giving up — otherwise CODEX_E2B_DONE above
    // could never have been produced on an exhausted token. This is exactly the
    // failure that stalled deploy; it passes trivially when the OAuth token is
    // healthy (no usage-limit event → no requirement).
    const sawRecoverableOAuthFailure = events.some((event) => {
      const typed = event as { type?: string; message?: string };
      return (
        typed.type === 'error' &&
        /usage[ _]limit|usage_limit_reached|hit your usage limit|purchase more credits|refresh_token_invalidated|refresh token (?:was )?revoked|access token could not be refreshed|your session has ended|log out and sign in again/i.test(
          String(typed.message ?? '')
        )
      );
    });
    const sawAuthFallback = events.some((event) => {
      const typed = event as { type?: string; to?: string };
      return typed.type === 'auth_fallback' && typed.to === 'openai_api_key';
    });
    if (sawRecoverableOAuthFailure) {
      assert(
        sawAuthFallback,
        `Codex OAuth credential failed but did NOT fall back to the OpenAI API key. events=${JSON.stringify(events).slice(-1000)}`
      );
      console.log(
        '    ↳ codex smoke completed via OPENAI_API_KEY runtime fallback (OAuth unusable)'
      );
    } else {
      console.log('    ↳ codex smoke completed via ChatGPT OAuth token (no usage limit hit)');
    }

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
    {
      name: 'template -- pins GPT-5.6-compatible Codex CLI',
      fn: testTemplate_pinsCodexCliForGpt56,
    },
    {
      name: 'auth -- revoked OAuth refresh token triggers funded-key fallback',
      fn: testRuntimeFallback_recognizesRevokedOAuthRefreshToken,
    },
    {
      name: 'auth -- OAuth primary + OPENAI_API_KEY runtime fallback injected together',
      fn: async () => testResolveCodexAuthEnvs_oauthPrimaryWithApiKeyRuntimeFallback(),
    },
    {
      name: 'auth -- OAuth alone when no funded key configured',
      fn: async () => testResolveCodexAuthEnvs_oauthWithoutFundedKey(),
    },
    {
      name: 'auth -- falls back to OPENAI_API_KEY when token unavailable/rate-limited',
      fn: async () => testResolveCodexAuthEnvs_apiKeyFallback(),
    },
    {
      name: 'auth -- throws when no credential and no funded key',
      fn: async () => testResolveCodexAuthEnvs_noCredsNoKeyThrows(),
    },
    {
      name: 'auth -- throws when funded key is empty',
      fn: async () => testResolveCodexAuthEnvs_emptyKeyThrows(),
    },
    {
      name: 'auth -- cooled funded key is excluded before sandbox creation',
      fn: async () => testResolveCodexAuthEnvs_cooldownExcludesFundedKey(),
    },
    {
      name: 'feedback -- captured OAuth exhaustion cools exact credential',
      fn: testPersistOutput_coolsExhaustedOAuthCredential,
    },
    {
      name: 'feedback -- failed OAuth fallback cools OAuth and funded credentials',
      fn: testPersistOutput_coolsBothCredentialsAfterFailedFallback,
    },
    {
      name: 'feedback -- invalid structured credential event is rejected',
      fn: testPersistOutput_rejectsInvalidCredentialFeedback,
    },
    {
      name: 'smoke-skip -- credit exhaustion detected across output and events',
      fn: async () => testDetectCreditExhaustion_positive(),
    },
    {
      name: 'smoke-skip -- observed OpenAI $0-balance wording is detected',
      fn: async () => testDetectCreditExhaustion_observedOpenAiWording(),
    },
    {
      name: 'smoke-skip -- healthy run and bare re-auth error are NOT fundless skips',
      fn: async () => testDetectCreditExhaustion_negative(),
    },
    {
      name: 'smoke-skip -- success sentinel is never overridden by exhaustion',
      fn: async () => testCreditExhaustion_neverOverridesSuccessSentinel(),
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
    const icon = result.skipped ? '  SKIP' : result.passed ? '  PASS' : '  FAIL';
    const suffix = result.skipped
      ? ` -- ${result.skipReason}`
      : result.passed
        ? ''
        : ` -- ${result.error}`;
    console.log(`${icon}  ${result.name}${suffix} (${result.duration}ms)`);
  }

  const failed = results.filter((r) => !r.passed);
  const skipped = results.filter((r) => r.skipped);
  const passed = results.filter((r) => r.passed && !r.skipped);
  console.log('\n' + '='.repeat(50));
  console.log(
    `\nResults: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`
  );
  if (failed.length > 0) {
    process.exit(1);
  }
  console.log('\nALL CODEX-CODE BLACK-BOX TESTS PASSED\n');
}

runAll().catch((error) => {
  console.error('\nBlack-box test suite crashed:', error);
  process.exit(1);
});
