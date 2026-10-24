#!/usr/bin/env tsx
import { config } from 'dotenv';
import { assertSmokeHandoff, handoffSmokeGoal } from './code-agent-handoff-smoke.case';
import { z } from 'zod';
import { prisma } from '../../providers/database';
import { retryWithBackoff } from '../../providers/retry';
import {
  testPersistOutput_coolsExhaustedOAuthCredential,
  testPersistOutput_coolsFundedKeyForObservedBalanceError,
} from './codex-code-oauth-feedback.case';
import { testCodexWsServerOverlayUsesLocalSource } from './codex-code-overlay.case';
import {
  testResolveCodexAuthEnvs_apiKeyFallback,
  testResolveCodexAuthEnvs_cooldownExcludesFundedKey,
  testResolveCodexAuthEnvs_emptyKeyThrows,
  testResolveCodexAuthEnvs_noCredsNoKeyThrows,
  testResolveCodexAuthEnvs_oauthPrimaryWithApiKeyRuntimeFallback,
  testResolveCodexAuthEnvs_oauthWithoutFundedKey,
} from './codex-code-auth-envs.case';
import {
  testCodexCreditSkip_matchesLiveOutOfCreditsWording,
  testCodexCreditSkip_readsNestedErrorObject,
  testCodexCreditSkip_successStillWins,
  testCodexCreditSkip_authRevocationStillFailsHard,
  testCodexCreditSkip_matchesE2bTeamBlockedWording,
  testCodexCreditSkip_createUnavailableOnCooldownIsSkip,
} from './codex-credit-skip.case';
import {
  testPromptBuilder_sharedContractMentionsOutputRules,
  testRuntimeFallback_recognizesRevokedOAuthRefreshToken,
  testTemplate_pinsCodexCliForGpt56,
} from './codex-template-contract.case';
import {
  CredentialExhaustionSkip,
  runTest,
  type TestResult,
  codexCreateUnavailableSkipReason,
  codexOauthRevocationSignal,
  codexSmokeCreditSkipReason,
  detectCodexCreditExhaustion,
  testCreateUnavailableSkip_cooldownOnly,
  testCreditExhaustion_neverOverridesSuccessSentinel,
  testDetectCreditExhaustion_negative,
  testDetectCreditExhaustion_observedOpenAiWording,
  testDetectCreditExhaustion_positive,
} from './codex-credit-skip';
import { waitForCodexOutput } from './codex-ws-output.support';
import { cooldownIsLive, waitForServerFundedKeyCooldown } from './funded-key-cooldown.support';
import { assert, assertStatus, request } from './codex-sandbox.support';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const DEV_USER_ID = process.env.CODEX_BLACKBOX_USER_ID || '1f85ff25-6e29-4c1b-8739-f917bd101a30';

const ErrorResponse = z.object({ error: z.string() });

function apiKeyHeaders(): Record<string, string> {
  return { 'X-API-Key': API_KEY };
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
        userId_name_accountId: {
          userId: '00000000-0000-0000-0000-000000000000',
          name: 'gpt_api_key_cooldown',
          accountId: '',
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
    await waitForServerFundedKeyCooldown({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      key: 'gpt',
      onCooldown: false,
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

/**
 * Feedback cases on this backend cool the shared funded key and then delete
 * its row; the backend honors that within its 15-second recheck interval.
 */
async function waitForFundedGptKeyRestore(): Promise<void> {
  await retryWithBackoff(
    () =>
      request(`${BASE_URL}/api/integrations/compute-code/gpt-key/cooldown`, {
        headers: apiKeyHeaders(),
      }),
    {
      maxRetries: 21,
      fixedDelays: Array.from({ length: 20 }, () => 1500),
      shouldRetryResult: (res) => (res.data as { onCooldown?: boolean }).onCooldown === true,
      component: 'CodexSmokeFundedKey',
    }
  );
}

async function testSmoke_codexCompletesE2bTask() {
  assert(API_KEY !== '', 'BACKEND_API_KEY is required');
  assert(
    process.env.E2B_API_KEY !== undefined && process.env.E2B_API_KEY !== '',
    'E2B_API_KEY is required'
  );
  await waitForFundedGptKeyRestore();
  const agentId = crypto.randomUUID();
  let taskId: string | undefined;
  let sandboxId: string | undefined;
  let closed = false;
  const sharedCooldown = await prisma.integration.findUnique({
    where: {
      userId_name_accountId: {
        userId: '00000000-0000-0000-0000-000000000000',
        name: 'gpt_api_key_cooldown',
        accountId: '',
      },
    },
    select: { rateLimitedUntil: true },
  });
  if (!cooldownIsLive(sharedCooldown)) {
    await waitForServerFundedKeyCooldown({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      key: 'gpt',
      onCooldown: false,
    });
  }

  try {
    const createRes = await request(`${BASE_URL}/api/codex-code-session/create`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        agent_id: agentId,
        user_id: DEV_USER_ID,
        goal: handoffSmokeGoal(
          'Create /home/user/output/codex-smoke.txt containing exactly CODEX_E2B_OK. Then reply with exactly CODEX_E2B_DONE.'
        ),
      }),
    });
    // Create-time funding/billing blocks (OpenAI org or E2B team) never reach a
    // sandbox — same deploy-approved SKIP as mid-run credential exhaustion.
    if (createRes.status !== 200) {
      const createBody =
        typeof createRes.data === 'string' ? createRes.data : JSON.stringify(createRes.data ?? {});
      let createSkip = detectCodexCreditExhaustion(createBody, []);
      if (!createSkip) {
        const cooldownRes = await request(
          `${BASE_URL}/api/integrations/compute-code/gpt-key/cooldown`,
          {
            headers: apiKeyHeaders(),
          }
        );
        const onCooldown = (cooldownRes.data as { onCooldown?: boolean }).onCooldown === true;
        createSkip = codexCreateUnavailableSkipReason(createBody, onCooldown);
      }
      if (createSkip) {
        throw new CredentialExhaustionSkip(
          `Codex/E2B session create blocked by external funding/billing (${createRes.status}); smoke SKIPPED without failing the deploy gate. Signal: ${createSkip}. Body: ${createBody.slice(0, 400)}`
        );
      }
    }
    assertStatus(createRes.status, 200, createRes.data);

    const body = createRes.data as {
      ws_url?: string;
      task_id?: string;
      sandbox_id?: string;
    };
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
      `Codex output did not include CODEX_E2B_DONE. exit=${exitCode ?? 'unknown'} oauth_revocation=${JSON.stringify(codexOauthRevocationSignal(output, events))} events=${JSON.stringify(events).slice(-800)} Tail: ${output.slice(-1200)}`
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
    const sandbox = await Sandbox.connect(sandboxId!, {
      apiKey: process.env.E2B_API_KEY,
    });
    const promptFile = await sandbox.files.read('/home/user/AGENTS.md', {
      format: 'text',
    });
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
    // The parent's result is the handoff file the real CLI wrote.
    const closeRes = await request(`${BASE_URL}/api/codex-code-session/close`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({ task_id: taskId }),
    });
    closed = true;
    assertStatus(closeRes.status, 200, closeRes.data);
    assertSmokeHandoff(closeRes.data, 'CODEX_E2B_OK', '/home/user/output/codex-smoke.txt');
  } finally {
    if (taskId && !closed) {
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

  const tests: { name: string; fn: () => Promise<void> }[] = [];
  // The feedback cases put the shared funded GPT key on cooldown, and the backend caches that
  // cooldown in-process for its full window; deleting the DB row afterwards does not undo it.
  // Without a synced Codex OAuth credential the smoke depends on that key, so it must run first.
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
  tests.push(
    { name: 'POST /create -- no auth -> 401', fn: testCreate_noAuth },
    {
      name: 'POST /create -- missing user_id -> 500',
      fn: testCreate_missingUserId,
    },
    {
      name: 'prompt -- shared code-agent contract includes output rules',
      fn: testPromptBuilder_sharedContractMentionsOutputRules,
    },
    {
      name: 'template -- pins GPT-5.6-compatible Codex CLI',
      fn: testTemplate_pinsCodexCliForGpt56,
    },
    {
      name: 'template -- overlays the local Codex fallback server for default and custom IDs',
      fn: testCodexWsServerOverlayUsesLocalSource,
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
      name: 'credit-skip -- live "no credits remaining" wording is recognized',
      fn: async () => testCodexCreditSkip_matchesLiveOutOfCreditsWording(),
    },
    {
      name: 'credit-skip -- nested error.message is searched',
      fn: async () => testCodexCreditSkip_readsNestedErrorObject(),
    },
    {
      name: 'credit-skip -- success sentinel always wins over skip',
      fn: async () => testCodexCreditSkip_successStillWins(),
    },
    {
      name: 'credit-skip -- auth revocation still fails hard',
      fn: async () => testCodexCreditSkip_authRevocationStillFailsHard(),
    },
    {
      name: 'credit-skip -- E2B team-blocked / missing payment method is recognized',
      fn: async () => testCodexCreditSkip_matchesE2bTeamBlockedWording(),
    },
    {
      name: 'credit-skip -- create unavailable + funded-key cooldown is recognized',
      fn: async () => testCodexCreditSkip_createUnavailableOnCooldownIsSkip(),
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
      name: 'feedback -- observed API balance error cools funded key without masking revocation',
      fn: testPersistOutput_coolsFundedKeyForObservedBalanceError,
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
    {
      name: 'smoke-skip -- create unavailable + cooldown is a funding skip',
      fn: async () => testCreateUnavailableSkip_cooldownOnly(),
    }
  );

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
