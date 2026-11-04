#!/usr/bin/env tsx
import { config } from 'dotenv';
import { assertSmokeHandoff, handoffSmokeGoal } from './code-agent-handoff-smoke.case';
import { z } from 'zod';
import { prisma } from '../../providers/database';
import {
  __resetCodexFundedCooldown,
  codexFundedCooldownUntil,
} from '../../providers/codeSessions/usageLimit';
import {
  testPersistOutput_coolsExhaustedOAuthCredential,
  testPersistOutput_coolsFundedKeyForObservedBalanceError,
} from './codex-code-oauth-feedback.case';
import { testCodexWsServerOverlayUsesLocalSource } from './codex-code-overlay.case';
import {
  testCodeAgentModels_createAgentRequestReachesCodeAgent,
  testCodeAgentModels_inspectAzureTierFollowsSpeed,
  testCodeAgentModels_overridesWin,
  testCodeAgentModels_tierTableAndUnknownIsFlash,
  testCodeAgentModels_wsServerFallbacksMatchFlash,
} from './codex-code-model.case';
import {
  testResolveCodexAuthEnvs_apiKeyFallback,
  testResolveCodexAzureFunding_selectsRegionByDeployment,
  testResolveCodexAuthEnvs_noCredsNoKeyThrows,
  testResolveCodexAuthEnvs_oauthPrimaryWithApiKeyRuntimeFallback,
  testResolveCodexAuthEnvs_oauthWithoutFundedKey,
} from './codex-code-auth-envs.case';
import {
  testCodexCreditSkip_matchesLiveOutOfCreditsWording,
  testCodexCreditSkip_readsNestedErrorObject,
  testCodexCreditSkip_successStillWins,
  testCodexCreditSkip_authRevocationStillFailsHard,
  testCodexCreditSkip_structuredUnusableLoginPausedForRetryIsSkip,
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
  codexSmokeLoginUnusableSkipReason,
  detectCodexCreditExhaustion,
  testCreateUnavailableSkip_cooldownOnly,
  testCreditExhaustion_neverOverridesSuccessSentinel,
  testDetectCreditExhaustion_negative,
  testDetectCreditExhaustion_observedOpenAiWording,
  testDetectCreditExhaustion_positive,
} from './codex-credit-skip';
import { waitForCodexOutput } from './codex-ws-output.support';
import {
  assertSmokeSettings,
  deleteSmokeParent,
  liveSessionSettings,
  smokeParentAgent,
} from './code-agent-settings-smoke.support';
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
  assertStatus(res.status, 400, res.data);
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
  await __resetCodexFundedCooldown();
  const openAiKeyBefore = await openAiKeyCooldownUntil();
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

    const fundedUntil = await codexFundedCooldownUntil();
    assert(
      fundedUntil !== null && fundedUntil.getTime() > Date.now(),
      'failed OAuth-to-Azure fallback must back off the funded Azure Codex deployment'
    );
    assert(
      (await openAiKeyCooldownUntil()) === openAiKeyBefore,
      'failed OAuth-to-Azure fallback must not cool the shared OpenAI key (Rose chat path)'
    );
  } finally {
    await prisma.claudeCodeSession.deleteMany({ where: { id: taskId } });
    await prisma.integration.deleteMany({ where: { id: integration.id } });
    await __resetCodexFundedCooldown();
  }
}

/** The shared OpenAI-key cooldown end; Codex credential feedback must never move it. */
async function openAiKeyCooldownUntil(): Promise<number | null> {
  const row = await prisma.integration.findUnique({
    where: {
      userId_name_accountId: {
        userId: '00000000-0000-0000-0000-000000000000',
        name: 'gpt_api_key_cooldown',
        accountId: '',
      },
    },
    select: { rateLimitedUntil: true },
  });
  return row?.rateLimitedUntil?.getTime() ?? null;
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
  // The parent's tier and Fast Mode button decide the CLI model, effort and speed.
  const parent = await smokeParentAgent(DEV_USER_ID);
  const agentId = parent.agentId;
  let taskId: string | undefined;
  let sandboxId: string | undefined;
  let closed = false;

  try {
    const createRes = await request(`${BASE_URL}/api/codex-code-session/create`, {
      method: 'POST',
      headers: apiKeyHeaders(),
      body: JSON.stringify({
        agent_id: agentId,
        user_id: DEV_USER_ID,
        // The result is the handoff (turn/start outputSchema makes the final
        // message that JSON), so no free-text reply sentinel is requested.
        goal: handoffSmokeGoal(
          'Create /home/user/output/codex-smoke.txt containing exactly CODEX_E2B_OK.'
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
        // The funded Codex path is the Azure deployment; its backoff is a DB row.
        const onCooldown = (await codexFundedCooldownUntil()) !== null;
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
    // Classify the run before persisting its output: an exhausted run can end
    // with no output at all, and the output route rejects an empty body, which
    // would hide the deploy-approved credit SKIP (and any real failure) behind
    // a 400.
    // Before treating a missing sentinel as a hard failure, check whether the
    // run simply ran out of credits on EVERY credential path (OAuth + funded
    // key). That is an external funding state, not a code regression, so it is
    // a deploy-approved SKIP rather than a FAIL.
    const turnCompleted = events.some((event) => {
      const typed = event as { type?: string; raw_type?: string; status?: string };
      return (
        typed.type === 'turn_ended' &&
        typed.raw_type === 'turn/completed' &&
        typed.status === 'completed'
      );
    });
    const succeeded = turnCompleted || exitCode === 0;
    // A completed turn is the success signal; success always wins over a skip.
    // Subscriptions first (C15): a revoked login with another subscription leasable
    // runs without the Azure switch and pauses for the parent's retry on that
    // subscription. The login is unavailable until reconnected: SKIP, never PASS.
    const unusableLogin = succeeded ? null : codexSmokeLoginUnusableSkipReason(events);
    if (unusableLogin) {
      throw new CredentialExhaustionSkip(
        `Codex login unusable (revoked or refresh failed) with no Azure switch armed; the run paused for a retry on the next credential. Reconnect the Codex login. Smoke SKIPPED without failing the deploy gate. Signal: ${unusableLogin}. exit=${exitCode ?? 'unknown'}`
      );
    }
    const creditSkip = succeeded ? null : codexSmokeCreditSkipReason(output, events);
    if (creditSkip) {
      throw new CredentialExhaustionSkip(
        `Codex credentials exhausted (out of credits/quota) on all paths; smoke SKIPPED without failing the deploy gate. Signal: ${creditSkip}. exit=${exitCode ?? 'unknown'}`
      );
    }
    assert(
      succeeded,
      `Codex turn did not complete. exit=${exitCode ?? 'unknown'} oauth_revocation=${JSON.stringify(codexOauthRevocationSignal(output, events))} events=${JSON.stringify(events).slice(-800)} Tail: ${output.slice(-1200)}`
    );
    // App-server can complete a turn with an empty transcript; persist only
    // populated output after the outcome has been classified.
    if (output !== '') {
      const outputRes = await request(`${BASE_URL}/api/codex-code-session/${taskId}/output`, {
        method: 'POST',
        headers: apiKeyHeaders(),
        body: JSON.stringify({ output }),
      });
      assertStatus(outputRes.status, 200, outputRes.data);
    }
    assert(
      events.some((event) => {
        const typed = event as { type?: string; provider?: string };
        return typed.provider === 'codex' && typed.type === 'session';
      }),
      `Expected normalized Codex session event, got: ${JSON.stringify(events).slice(0, 500)}`
    );

    // Runtime-fallback invariant: if the ChatGPT login proved unusable (revoked,
    // refresh failed) mid-run and the run still completed, the sandbox switched to
    // the funded Azure deployment (auth_fallback event). The switch is armed only
    // when no other subscription is leasable (subscriptions first, C15); otherwise
    // the run fails above (a revoked login stays a hard failure) and the parent's
    // retry takes that subscription. A usage limit is not switched in the sandbox:
    // it pauses for the parent's retry, so a limited run is a credit SKIP above.
    const sawRecoverableOAuthFailure = events.some((event) => {
      const typed = event as { type?: string; message?: string };
      return (
        typed.type === 'error' &&
        /refresh_token_invalidated|refresh token (?:was )?revoked|access token could not be refreshed|your session has ended|log out and sign in again/i.test(
          String(typed.message ?? '')
        )
      );
    });
    const sawAuthFallback = events.some((event) => {
      const typed = event as { type?: string; to?: string };
      return typed.type === 'auth_fallback' && typed.to === 'openai_api_key';
    });
    // The task row records what served the run at spawn: a ChatGPT login ('user' | 'pool')
    // or the funded Azure deployment alone ('azure').
    const servedBy = (
      await prisma.claudeCodeSession.findUnique({
        where: { id: taskId },
        select: { claudeTokenSource: true },
      })
    )?.claudeTokenSource;
    assert(
      servedBy === 'user' || servedBy === 'pool' || servedBy === 'azure',
      `Codex task must record the credential that served it, got ${String(servedBy)}`
    );
    if (sawRecoverableOAuthFailure) {
      assert(
        sawAuthFallback,
        `Codex OAuth credential failed but did NOT fall back to the Azure deployment. events=${JSON.stringify(events).slice(-1000)}`
      );
      console.log(
        `    ↳ codex smoke completed via the Azure funded runtime fallback (${servedBy} OAuth unusable)`
      );
    } else if (servedBy === 'azure') {
      console.log('    ↳ codex smoke completed on the funded Azure deployment (no ChatGPT login)');
    } else {
      console.log(`    ↳ codex smoke completed via ${servedBy} ChatGPT OAuth (no usage limit hit)`);
    }

    const { Sandbox } = await import('e2b');
    const sandbox = await Sandbox.connect(sandboxId!, {
      apiKey: process.env.E2B_API_KEY,
    });
    // What the run really served: the session's own effective settings, and on
    // Azure the funded provider's host and tier from the sandbox log.
    const onAzure = servedBy === 'azure' || sawAuthFallback;
    const proof = assertSmokeSettings(
      'codex',
      parent,
      await liveSessionSettings(body.ws_url!, taskId),
      {
        azure: onAzure,
      }
    );
    console.log(`    ↳ codex smoke ${proof}`);
    if (onAzure) {
      const wsLog = String(
        await sandbox.files.read('/tmp/codex-ws-server.log', { format: 'text' })
      );
      const funded = wsLog
        .split('\n')
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find((line) => line?.message === 'Using the Azure OpenAI funded provider');
      assert(funded !== undefined && funded !== null, 'the sandbox logged the Azure provider');
      console.log(
        `    ↳ codex smoke Azure host=${String(funded.host)} model=${String(funded.model)} service_tier=${String(funded.service_tier)} effort=${String(funded.effort)}`
      );
      assert(
        String(funded.host).includes('southcentralus') ||
          process.env.CODEX_AZURE_FOUNDRY_HOST !== undefined,
        `Azure host ${String(funded.host)} is the region deploying gpt-6.1-sol`
      );
    }
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
    await deleteSmokeParent(parent);
  }
}

async function runAll() {
  console.log('Codex Code Session Black-Box Tests\n');
  console.log(`Testing against: ${BASE_URL}\n`);

  const tests: { name: string; fn: () => Promise<void> }[] = [];
  // The feedback cases back the funded Azure Codex deployment off (codex_funded_cooldown) and
  // reset it afterwards. Without a synced Codex OAuth credential the smoke depends on that
  // deployment, so it runs first.
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
      name: 'auth -- OAuth primary + Azure runtime fallback injected together',
      fn: async () => testResolveCodexAuthEnvs_oauthPrimaryWithApiKeyRuntimeFallback(),
    },
    {
      name: 'auth -- OAuth alone when no Azure deployment configured',
      fn: async () => testResolveCodexAuthEnvs_oauthWithoutFundedKey(),
    },
    {
      name: 'auth -- falls back to the Azure deployment when token unavailable/rate-limited',
      fn: async () => testResolveCodexAuthEnvs_apiKeyFallback(),
    },
    {
      name: 'auth -- Azure funding resolves from the region that deploys gpt-6.1-sol',
      fn: async () => testResolveCodexAzureFunding_selectsRegionByDeployment(),
    },
    {
      name: 'model -- tier table: Opus 5.5 / GPT-6.1 Sol, ultra xhigh, flash medium, unknown = flash',
      fn: async () => testCodeAgentModels_tierTableAndUnknownIsFlash(),
    },
    {
      name: 'model -- env overrides win over every tier',
      fn: async () => testCodeAgentModels_overridesWin(),
    },
    {
      name: 'model -- ws-server fallbacks equal the flash row; Azure catalog is priority-only',
      fn: async () => testCodeAgentModels_wsServerFallbacksMatchFlash(),
    },
    {
      name: 'model -- Azure exec asks for priority only when the agent is fast',
      fn: async () => testCodeAgentModels_inspectAzureTierFollowsSpeed(),
    },
    {
      name: 'model -- POST /api/agents model + fast_mode_cache_enabled reach the code agent and Azure tier',
      fn: () =>
        testCodeAgentModels_createAgentRequestReachesCodeAgent(BASE_URL, {
          'X-API-Key': API_KEY,
          'X-User-Id': DEV_USER_ID,
        }),
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
      name: 'credit-skip -- structured unusable login paused for a retry is a skip',
      fn: async () => testCodexCreditSkip_structuredUnusableLoginPausedForRetryIsSkip(),
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
      name: 'auth -- throws when no credential and no Azure deployment',
      fn: async () => testResolveCodexAuthEnvs_noCredsNoKeyThrows(),
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
