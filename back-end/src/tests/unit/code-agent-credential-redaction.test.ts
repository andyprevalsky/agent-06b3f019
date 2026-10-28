#!/usr/bin/env tsx
/**
 * Credential-resolution failures must not leak our credential inventory to API clients.
 *
 * `POST /api/claude-code-session/create` and `POST /api/codex-code-session/create` both end their
 * catch with `res.status(500).json({ error: error.message })` — the thrown message is returned
 * VERBATIM. So a message that names which sources were tried (synced user credentials, pool tokens,
 * the shared funded key, whether that key is on an out-of-credits cooldown) hands any authenticated
 * caller a map of our credential state. The operator-facing breakdown belongs on `detail`, which is
 * logged server-side and never serialized into a response.
 *
 * This lives in the unit suite (not only the code-agent blackboxes) because those blackboxes need a
 * running backend, and a redaction guarantee has to hold on every offline run too.
 */

import assert from 'node:assert/strict';
import {
  CODE_AGENT_CREDENTIALS_UNAVAILABLE,
  CodeAgentCredentialError,
  isRefreshOnlyOauthEnvelope,
  resolveClaudeCodeAuthEnvs,
  resolveClaudeCodeSandboxApiKey,
  resolveCodexCodeAuthEnvs,
  resolveHostAnthropicBaseUrl,
  shouldIgnoreAnthropicApiKeyCooldownForSandbox,
  shouldPreferSandboxAnthropicBaseUrlOverFastMode,
  shouldEnableClaudeCodeFastMode,
  shouldInjectClaudeCodeFastModeProxy,
  shouldSkipSandboxAnthropicGatewayForOauth,
} from '../../providers/e2b';

/** Substrings that describe our credential inventory and must never reach a client body. */
const DISCLOSURES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GPT_API_KEY',
  'pool tokens',
  'synced user credentials',
  'cooldown',
];

function captureCredentialFailure(run: () => unknown, label: string): CodeAgentCredentialError {
  try {
    run();
  } catch (error) {
    assert.ok(
      error instanceof CodeAgentCredentialError,
      `${label}: expected CodeAgentCredentialError, got ${String(error)}`
    );
    return error;
  }
  throw new assert.AssertionError({ message: `${label}: expected a credential-resolution throw` });
}

function assertRedacted(error: CodeAgentCredentialError, label: string): void {
  assert.equal(
    error.message,
    CODE_AGENT_CREDENTIALS_UNAVAILABLE,
    `${label}: the client-facing message must be the fixed redacted string`
  );
  for (const disclosure of DISCLOSURES) {
    assert.ok(
      !error.message.includes(disclosure),
      `${label}: client-facing message leaked "${disclosure}": ${error.message}`
    );
  }
  // The route also logs `error.message`; the operator signal has to survive somewhere, so `detail`
  // must stay specific enough to triage without DB/env archaeology.
  assert.ok(error.detail.length > error.message.length, `${label}: detail must stay diagnostic`);
}

function main(): void {
  const claudeUnset = captureCredentialFailure(
    () => resolveClaudeCodeAuthEnvs(null, undefined, false),
    'claude/no-key'
  );
  assertRedacted(claudeUnset, 'claude/no-key');
  assert.ok(
    claudeUnset.detail.includes('ANTHROPIC_API_KEY is not set'),
    `claude/no-key: detail must name the missing key, got: ${claudeUnset.detail}`
  );

  const claudeCooled = captureCredentialFailure(
    () => resolveClaudeCodeAuthEnvs(null, 'sk-ant-api03-key', true),
    'claude/cooldown'
  );
  assertRedacted(claudeCooled, 'claude/cooldown');
  assert.ok(
    claudeCooled.detail.includes('out-of-credits/bad-key cooldown'),
    `claude/cooldown: detail must name the cooldown, got: ${claudeCooled.detail}`
  );
  // The two branches demand different remediation, so they must stay distinguishable in the logs
  // even though they are indistinguishable to the client.
  assert.notEqual(claudeUnset.detail, claudeCooled.detail);
  assert.equal(claudeUnset.message, claudeCooled.message);

  const codexUnset = captureCredentialFailure(
    () => resolveCodexCodeAuthEnvs(null, undefined),
    'codex/no-funding'
  );
  assertRedacted(codexUnset, 'codex/no-funding');
  assert.ok(
    codexUnset.detail.includes('Azure Codex deployment'),
    `codex/no-funding: detail must name the missing fallback, got: ${codexUnset.detail}`
  );

  // A credential value itself must never be echoed anywhere in the surfaced error.
  for (const error of [claudeCooled, codexUnset]) {
    assert.ok(!error.message.includes('sk-'), 'a raw key prefix must never reach the client');
    assert.ok(!error.detail.includes('sk-'), 'a raw key prefix must never reach the logs either');
  }

  assert.equal(resolveHostAnthropicBaseUrl(undefined), undefined);
  assert.equal(resolveHostAnthropicBaseUrl(''), undefined);
  assert.equal(resolveHostAnthropicBaseUrl('  '), undefined);
  assert.equal(
    resolveHostAnthropicBaseUrl(' https://openrouter.ai/api '),
    'https://openrouter.ai/api'
  );

  assert.equal(isRefreshOnlyOauthEnvelope(null), false);
  assert.equal(
    isRefreshOnlyOauthEnvelope({
      credentialMode: 'oauth_token',
      accessToken: 'tok',
      source: 'user',
      userId: 'u1',
    }),
    false
  );
  assert.equal(
    isRefreshOnlyOauthEnvelope({
      credentialMode: 'oauth_envelope',
      credentials: '{"claudeAiOauth":{}}',
      source: 'user',
      userId: 'u1',
    }),
    true
  );
  assert.equal(
    isRefreshOnlyOauthEnvelope({
      credentialMode: 'oauth_envelope',
      credentials: '{"claudeAiOauth":{}}',
      accessToken: 'still-present',
      source: 'user',
      userId: 'u1',
    }),
    false
  );

  assert.equal(resolveClaudeCodeSandboxApiKey(undefined, 'sk-ant-shared').apiKey, 'sk-ant-shared');
  assert.equal(
    resolveClaudeCodeSandboxApiKey('sk-or-gateway', 'sk-ant-shared').apiKey,
    'sk-or-gateway'
  );
  assert.equal(
    resolveClaudeCodeSandboxApiKey(undefined, 'sk-ant-shared', {
      anthropicBaseUrl: 'https://openrouter.ai/api',
      openrouterApiKey: 'sk-or-gateway',
    }).apiKey,
    'sk-or-gateway'
  );
  assert.deepEqual(
    resolveClaudeCodeSandboxApiKey(undefined, 'sk-ant-shared', {
      openrouterApiKey: 'sk-or-gateway',
      sharedKeyOnCooldown: true,
    }),
    { apiKey: 'sk-or-gateway', baseUrl: 'https://openrouter.ai/api' }
  );
  // Fleet Fast Mode path: OpenRouter present, no host base → always prefer
  // OpenRouter (even without cooldown / preferOpenRouterGateway).
  assert.deepEqual(
    resolveClaudeCodeSandboxApiKey(undefined, 'sk-ant-shared', {
      openrouterApiKey: 'sk-or-gateway',
    }),
    { apiKey: 'sk-or-gateway', baseUrl: 'https://openrouter.ai/api' }
  );
  assert.deepEqual(
    resolveClaudeCodeSandboxApiKey(undefined, 'sk-ant-shared', {
      openrouterApiKey: 'sk-or-gateway',
      preferOpenRouterGateway: true,
    }),
    { apiKey: 'sk-or-gateway', baseUrl: 'https://openrouter.ai/api' }
  );
  // Cooldown / Fast Mode must not keep a shared Anthropic key when OpenRouter is available —
  // even if ANTHROPIC_BASE_URL points at api.anthropic.com.
  assert.deepEqual(
    resolveClaudeCodeSandboxApiKey(undefined, 'sk-ant-shared', {
      anthropicBaseUrl: 'https://api.anthropic.com',
      openrouterApiKey: 'sk-or-gateway',
      sharedKeyOnCooldown: true,
    }),
    { apiKey: 'sk-or-gateway', baseUrl: 'https://openrouter.ai/api' }
  );
  assert.deepEqual(
    resolveClaudeCodeSandboxApiKey(undefined, 'sk-ant-shared', {
      anthropicBaseUrl: 'https://api.anthropic.com',
      openrouterApiKey: 'sk-or-gateway',
      preferOpenRouterGateway: true,
    }),
    { apiKey: 'sk-or-gateway', baseUrl: 'https://openrouter.ai/api' }
  );
  // Without cooldown / Fast Mode preference, honor an explicit Anthropic host base.
  assert.deepEqual(
    resolveClaudeCodeSandboxApiKey(undefined, 'sk-ant-shared', {
      anthropicBaseUrl: 'https://api.anthropic.com',
      openrouterApiKey: 'sk-or-gateway',
    }),
    { apiKey: 'sk-ant-shared', baseUrl: 'https://api.anthropic.com' }
  );
  // Dedicated OpenRouter key without ANTHROPIC_BASE_URL still gets OpenRouter base.
  assert.deepEqual(resolveClaudeCodeSandboxApiKey('sk-or-dedicated', 'sk-ant-shared'), {
    apiKey: 'sk-or-dedicated',
    baseUrl: 'https://openrouter.ai/api',
  });
  // sk-or-* must ignore a host base that points at api.anthropic.com (HTTP 403).
  assert.deepEqual(
    resolveClaudeCodeSandboxApiKey('sk-or-dedicated', 'sk-ant-shared', {
      anthropicBaseUrl: 'https://api.anthropic.com',
    }),
    { apiKey: 'sk-or-dedicated', baseUrl: 'https://openrouter.ai/api' }
  );
  assert.equal(
    shouldIgnoreAnthropicApiKeyCooldownForSandbox({
      sandboxApiKey: 'sk-or-gateway',
      sharedAnthropicApiKey: 'sk-ant-shared',
      sandboxBaseUrl: undefined,
    }),
    true
  );
  assert.equal(
    shouldIgnoreAnthropicApiKeyCooldownForSandbox({
      sandboxApiKey: 'sk-ant-shared',
      sharedAnthropicApiKey: 'sk-ant-shared',
      sandboxBaseUrl: undefined,
    }),
    false
  );
  assert.equal(
    shouldIgnoreAnthropicApiKeyCooldownForSandbox({
      sandboxApiKey: 'sk-ant-shared',
      sharedAnthropicApiKey: 'sk-ant-shared',
      sandboxBaseUrl: 'https://openrouter.ai/api',
    }),
    true
  );
  // Explicit api.anthropic.com must keep the shared-key cooldown active.
  assert.equal(
    shouldIgnoreAnthropicApiKeyCooldownForSandbox({
      sandboxApiKey: 'sk-ant-shared',
      sharedAnthropicApiKey: 'sk-ant-shared',
      sandboxBaseUrl: 'https://api.anthropic.com',
    }),
    false
  );

  assert.equal(shouldPreferSandboxAnthropicBaseUrlOverFastMode('https://openrouter.ai/api'), true);
  assert.equal(shouldPreferSandboxAnthropicBaseUrlOverFastMode('https://api.anthropic.com'), false);
  assert.equal(shouldPreferSandboxAnthropicBaseUrlOverFastMode(undefined), false);

  // Andy write-through + OpenRouter must still disable Fast Mode for Claude Code
  // unless CLAUDE_CODE_FAST_MODE_ENABLED is explicitly on.
  assert.equal(
    shouldEnableClaudeCodeFastMode({
      openrouterApiKey: 'sk-or-gateway',
      fastModeCacheEnabled: true,
      fastModeWriteEnabled: true,
      claudeCodeFastModeEnabled: '1',
    }),
    false
  );
  assert.equal(
    shouldEnableClaudeCodeFastMode({
      fastModeCacheEnabled: true,
      fastModeWriteEnabled: true,
      claudeCodeFastModeEnabled: '1',
    }),
    true
  );
  // Default (no opt-in): Fast Mode off even for Andy write-through.
  assert.equal(
    shouldEnableClaudeCodeFastMode({
      fastModeCacheEnabled: true,
      fastModeWriteEnabled: true,
      claudeCodeFastModeEnabled: '',
    }),
    false
  );
  assert.equal(
    shouldEnableClaudeCodeFastMode({
      openrouterApiKey: '  ',
      fastModeWriteEnabled: true,
      claudeCodeFastModeEnabled: undefined,
    }),
    false
  );

  // Proxy injection must track the opt-in gate — Andy write-through alone must
  // not inject when Fast Mode is off (files-in-sub-agents k=5 t5, 2026-08-21).
  assert.equal(
    shouldInjectClaudeCodeFastModeProxy({
      codeAgentFastModeActive: false,
      preferSandboxBase: false,
    }),
    false
  );
  assert.equal(
    shouldInjectClaudeCodeFastModeProxy({
      codeAgentFastModeActive: true,
      preferSandboxBase: false,
    }),
    true
  );
  assert.equal(
    shouldInjectClaudeCodeFastModeProxy({
      codeAgentFastModeActive: true,
      preferSandboxBase: true,
    }),
    false
  );

  // OAuth must not ride OpenRouter / funded gateway base URLs.
  assert.equal(shouldSkipSandboxAnthropicGatewayForOauth(null), false);
  assert.equal(
    shouldSkipSandboxAnthropicGatewayForOauth({
      credentials: '{"claudeAiOauth":{}}',
      accessToken: 'oauth-access',
      source: 'user',
      poolTokenId: null,
      credentialMode: 'oauth_token',
    } as never),
    true
  );
  assert.equal(
    shouldSkipSandboxAnthropicGatewayForOauth({
      credentials: '{"claudeAiOauth":{"refreshToken":"r"}}',
      accessToken: undefined,
      source: 'user',
      poolTokenId: null,
      credentialMode: 'oauth_envelope',
    } as never),
    true
  );

  process.stdout.write('Code-agent credential redaction tests passed\n');
}

main();
