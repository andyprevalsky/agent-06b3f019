/**
 * Pure Claude/Codex code-agent credential + Fast Mode gating helpers.
 *
 * Split from `e2b.ts` so session orchestration stays under the max-lines budget
 * while selection logic remains unit-testable without spinning an E2B sandbox.
 */

import { createLogger } from './logger';
import type { ClaudeCodeCredentialResult } from './claudeCredentials';
import type { GptCodeCredentialEnvelopeResult } from './gptCredentials';

const log = createLogger('E2B');

/**
 * A code-agent session could not be given any usable credential.
 *
 * SECURITY: the `/api/claude-code-session/create` and `/api/[REDACTED]-session/create` handlers
 * return `error.message` VERBATIM in their 500 body, so anything the message says about our
 * credential inventory (which sources are synced, whether the shared funded key exists, whether it
 * is on an out-of-credits cooldown) is disclosed to every API caller. `message` is therefore a
 * fixed, state-free string; the operator-facing breakdown lives in `detail`, which is logged
 * server-side only and never returned.
 */
export class CodeAgentCredentialError extends Error {
  constructor(
    message: string,
    readonly detail: string
  ) {
    super(message);
    this.name = 'CodeAgentCredentialError';
  }
}

/**
 * The single client-facing string for a credential-resolution failure. Deliberately says only that
 * the session cannot start — never which credential source is missing, present, or cooled down.
 */
export const CODE_AGENT_CREDENTIALS_UNAVAILABLE =
  'Code agent credentials are unavailable; the session could not be started';

/**
 * Decide which auth env vars the Claude Code CLI sandbox should receive.
 *
 * Preference order (mirrors the Rose completions fallback so the code agent
 * stays usable everywhere an OAuth token would be):
 *   1. A synced/pool Claude OAuth credential → CLAUDE_CODE_CREDENTIALS (+ token).
 *   2. The funded ANTHROPIC_API_KEY (billed) — Claude Code CLI reads it natively
 *      — when no OAuth credential is available and the shared key isn't on its
 *      out-of-credits cooldown.
 *   3. Otherwise throw — nothing usable.
 *
 * Pure + exported so the selection is unit-testable without spinning an E2B
 * sandbox (the real session path isn't otherwise reachable in tests).
 */
export function resolveClaudeCodeAuthEnvs(
  credentialMeta: ClaudeCodeCredentialResult | null,
  anthropicApiKey: string | undefined,
  anthropicApiKeyOnCooldown: boolean
): Record<string, string> {
  const envs: Record<string, string> = {};
  if (credentialMeta) {
    if (credentialMeta.credentials) {
      envs.CLAUDE_CODE_CREDENTIALS = credentialMeta.credentials;
    }
    if (credentialMeta.accessToken) {
      envs.CLAUDE_CODE_OAUTH_TOKEN = credentialMeta.accessToken;
    }
    return envs;
  }
  if (anthropicApiKey && !anthropicApiKeyOnCooldown) {
    envs.ANTHROPIC_API_KEY = anthropicApiKey;
    return envs;
  }
  // Name WHICH fallback state failed. "unset or on cooldown" forced every
  // triage of this error into DB archaeology to tell a missing key (config
  // gap, fixable here) apart from an out-of-credits/bad-key cooldown
  // (external funding, not fixable here). The caller already resolved both
  // inputs, so the distinction is free. It stays on `detail` (logs only) —
  // the route echoes `message` straight back to the client.
  const fallbackState = anthropicApiKey
    ? 'ANTHROPIC_API_KEY is configured but on its out-of-credits/bad-key cooldown'
    : 'ANTHROPIC_API_KEY is not set';
  const detail =
    'No Claude Code credentials available: no synced user credentials, no available pool tokens, ' +
    `and no usable ANTHROPIC_API_KEY fallback (${fallbackState})`;
  log.error('Claude Code credential resolution failed', { detail });
  throw new CodeAgentCredentialError(CODE_AGENT_CREDENTIALS_UNAVAILABLE, detail);
}

export function resolveClaudeCodeTokenSource(
  credentialMeta: ClaudeCodeCredentialResult | null
): 'user' | 'pool' | 'anthropic' {
  return credentialMeta?.source ?? 'anthropic';
}

/**
 * The Integration row a Claude Code task runs on (pool token or the user's own
 * account), so a usage limit marks exactly that account; null for the funded key.
 */
export function claudeTaskIntegrationId(
  credentialMeta: ClaudeCodeCredentialResult | null
): string | null {
  if (credentialMeta === null) return null;
  if (credentialMeta.source === 'pool') return credentialMeta.poolTokenId ?? null;
  return credentialMeta.integrationId ?? null;
}

/**
 * Host ANTHROPIC_BASE_URL override for Claude Code sandboxes (Anthropic SDK
 * compatible gateways such as OpenRouter).
 */
export function resolveHostAnthropicBaseUrl(hostBaseUrl: string | undefined): string | undefined {
  const trimmed = hostBaseUrl?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Fast Mode tee-proxy for Claude Code is opt-in only.
 *
 * The benchmark user (Andy) is in `FAST_MODE_WRITE_THROUGH_USER_IDS`, which used
 * to force Fast Mode on every Claude Code session. Local stacks often skip the
 * proxy because `FAST_MODE_ANTHROPIC_PROXY_URL` is loopback-unreachable; fleet
 * proxies are public, so write-through alone produced HTTP 403 / stale
 * 0-interaction cache hits on files-in-sub-agents (2026-08-21). OpenRouter
 * recovery is also incompatible with the tee-proxy (forwards to api.anthropic.com).
 *
 * Set `CLAUDE_CODE_FAST_MODE_ENABLED=1` to re-enable when the proxy speaks a
 * funded Anthropic-compatible upstream.
 */
export function shouldEnableClaudeCodeFastMode(params: {
  openrouterApiKey?: string;
  fastModeCacheEnabled?: boolean;
  fastModeWriteEnabled?: boolean;
  /** process.env.CLAUDE_CODE_FAST_MODE_ENABLED — injected for tests */
  claudeCodeFastModeEnabled?: string;
}): boolean {
  const enabledFlag = (
    params.claudeCodeFastModeEnabled ?? process.env.CLAUDE_CODE_FAST_MODE_ENABLED
  )
    ?.trim()
    .toLowerCase();
  if (
    enabledFlag !== '1' &&
    enabledFlag !== 'true' &&
    enabledFlag !== 'yes' &&
    enabledFlag !== 'on'
  ) {
    return false;
  }
  if (params.openrouterApiKey?.trim()) return false;
  return params.fastModeCacheEnabled === true || params.fastModeWriteEnabled === true;
}

/**
 * Whether createClaudeCodeSession may inject the Fast Mode tee-proxy env.
 *
 * Must stay false whenever `shouldEnableClaudeCodeFastMode` is false — Andy
 * write-through (`fastModeWriteEnabled`) alone used to call
 * `buildFastModeAnthropicEnv` whenever `preferSandboxBase` was false, which
 * re-enabled stale 0-interaction cache hits / HTTP 403 on fleet
 * files-in-sub-agents (k=5 t5, 2026-08-21) after the opt-in gate landed.
 */
export function shouldInjectClaudeCodeFastModeProxy(params: {
  codeAgentFastModeActive: boolean;
  preferSandboxBase: boolean;
}): boolean {
  return params.codeAgentFastModeActive === true && params.preferSandboxBase !== true;
}

/**
 * Funded Anthropic-compatible gateways (OpenRouter auto-fallback when the shared
 * Anthropic org is credit-dead) must win over the Fast Mode tee-proxy.
 *
 * The Fast Mode proxy forwards sandbox keys to api.anthropic.com. An OpenRouter
 * key against that host returns HTTP 403 and zero Claude Code interactions —
 * the fleet files-in-sub-agents failure mode on 2026-08-21. Local stacks often
 * skip Fast Mode because the proxy URL is loopback-unreachable; fleet proxies
 * are public, so without this precedence the OpenRouter transport never sticks.
 */
export function shouldPreferSandboxAnthropicBaseUrlOverFastMode(
  sandboxBaseUrl: string | undefined
): boolean {
  const trimmed = sandboxBaseUrl?.trim();
  if (!trimmed) return false;
  try {
    const host = new URL(trimmed).hostname.toLowerCase();
    if (host === 'api.anthropic.com') return false;
    return true;
  } catch {
    return true;
  }
}

/**
 * Usable Claude OAuth must talk to api.anthropic.com — never OpenRouter.
 *
 * Pre-Deploy smoke 2026-08-21: OpenRouter was selected as the funded gateway
 * (`ANTHROPIC_BASE_URL=https://openrouter.ai/api`) while `resolveClaudeCodeAuthEnvs`
 * still injected the user's `oauth_token`. Claude Code then failed with
 * `401 Missing Authentication header` (OAuth is not an OpenRouter API key).
 * When OAuth is the session auth, skip every sandbox/gateway/Fast-Mode base URL
 * override so the CLI hits Anthropic's default host.
 */
export function shouldSkipSandboxAnthropicGatewayForOauth(
  credentialMeta: ClaudeCodeCredentialResult | null
): boolean {
  if (!credentialMeta) return false;
  return Boolean(credentialMeta.accessToken || credentialMeta.credentials);
}

/** Anthropic-compatible OpenRouter base used for Claude Code funded fallback. */
export const OPENROUTER_ANTHROPIC_COMPAT_BASE_URL = 'https://openrouter.ai/api';

/**
 * API key injected into the Claude Code sandbox.
 *
 * Prefer `CLAUDE_CODE_ANTHROPIC_API_KEY` when set so a gateway key (e.g.
 * OpenRouter) can back the sandbox without replacing the process-wide
 * `ANTHROPIC_API_KEY` that Rose uses against api.anthropic.com — swapping those
 * put the shared key on cooldown and blocked every later Claude Code session.
 *
 * When the host `ANTHROPIC_BASE_URL` points at OpenRouter, use `OPENROUTER_API_KEY`
 * if no dedicated Claude Code key is set (fleet guests already carry OpenRouter).
 *
 * When no host Anthropic base is set, prefer `OPENROUTER_API_KEY` over the bare
 * shared Anthropic key so Fast Mode cannot claim the session on fleet guests
 * that lack `ANTHROPIC_BASE_URL` / cooldown (2026-08-21).
 * `preferOpenRouterGateway` remains as an explicit signal from the Fast Mode path.
 */
export function resolveClaudeCodeSandboxApiKey(
  claudeCodeAnthropicApiKey: string | undefined,
  anthropicApiKey: string | undefined,
  options?: {
    anthropicBaseUrl?: string;
    openrouterApiKey?: string;
    sharedKeyOnCooldown?: boolean;
    /** Prefer OpenRouter over bare shared Anthropic (e.g. when Fast Mode would win). */
    preferOpenRouterGateway?: boolean;
  }
): { apiKey: string | undefined; baseUrl: string | undefined } {
  const dedicated = claudeCodeAnthropicApiKey?.trim();
  const hostBase = resolveHostAnthropicBaseUrl(options?.anthropicBaseUrl);
  const openrouter = options?.openrouterApiKey?.trim();
  const shared = anthropicApiKey?.trim();
  const openrouterBase = OPENROUTER_ANTHROPIC_COMPAT_BASE_URL;

  if (dedicated) {
    // Dedicated OpenRouter keys must never ride a host base that points at
    // api.anthropic.com — that yields HTTP 403 and also flips preferSandboxBase
    // false so the Fast Mode tee can re-engage.
    if (/^sk-or-/i.test(dedicated)) {
      const base = hostBase && /openrouter\.ai/i.test(hostBase) ? hostBase : openrouterBase;
      return { apiKey: dedicated, baseUrl: base };
    }
    // Dedicated non-OpenRouter keys still need the host base when set —
    // controller exports of ANTHROPIC_BASE_URL do not reach fleet guests.
    return { apiKey: dedicated, baseUrl: hostBase };
  }
  if (hostBase && openrouter && /openrouter\.ai/i.test(hostBase)) {
    return { apiKey: openrouter, baseUrl: hostBase };
  }
  // Prefer funded OpenRouter when: no host base (fleet guest), shared Anthropic
  // key is on cooldown, or Fast Mode would otherwise tee to api.anthropic.com.
  const preferOpenRouter =
    Boolean(openrouter) &&
    (!hostBase ||
      Boolean(options?.sharedKeyOnCooldown) ||
      Boolean(options?.preferOpenRouterGateway));
  if (preferOpenRouter && openrouter) {
    return { apiKey: openrouter, baseUrl: openrouterBase };
  }
  if (hostBase) {
    return { apiKey: shared, baseUrl: hostBase };
  }
  return { apiKey: shared, baseUrl: undefined };
}

/**
 * When the sandbox uses a dedicated gateway key or a non-default Anthropic base
 * URL, the shared Anthropic-org cooldown must not block session creation.
 * An explicit `api.anthropic.com` base must NOT bypass cooldown — that host is
 * exactly what the shared-key cooldown protects.
 */
export function shouldIgnoreAnthropicApiKeyCooldownForSandbox(params: {
  sandboxApiKey: string | undefined;
  sharedAnthropicApiKey: string | undefined;
  sandboxBaseUrl: string | undefined;
}): boolean {
  const trimmed = params.sandboxBaseUrl?.trim();
  if (trimmed) {
    try {
      const host = new URL(trimmed).hostname.toLowerCase();
      if (host !== 'api.anthropic.com') return true;
    } catch {
      return true;
    }
  }
  const sandbox = params.sandboxApiKey?.trim();
  const shared = params.sharedAnthropicApiKey?.trim();
  return Boolean(sandbox && shared && sandbox !== shared);
}

/**
 * Whether a Claude Code sandbox without an OAuth login can still authenticate:
 * the same key choice and cooldown gate `createClaudeCodeSession` (e2b.ts)
 * applies. OpenRouter or a dedicated key backs the CLI while the shared
 * Anthropic org is on cooldown, so that cooldown alone does not make Claude
 * Code unavailable.
 */
export function claudeCodeSandboxKeyUsable(params: {
  claudeCodeAnthropicApiKey: string | undefined;
  anthropicApiKey: string | undefined;
  anthropicBaseUrl: string | undefined;
  openrouterApiKey: string | undefined;
  sharedKeyOnCooldown: boolean;
}): boolean {
  const transport = resolveClaudeCodeSandboxApiKey(
    params.claudeCodeAnthropicApiKey,
    params.anthropicApiKey,
    {
      anthropicBaseUrl: params.anthropicBaseUrl,
      openrouterApiKey: params.openrouterApiKey,
      sharedKeyOnCooldown: params.sharedKeyOnCooldown,
    }
  );
  if (!transport.apiKey?.trim()) return false;
  if (!params.sharedKeyOnCooldown) return true;
  return shouldIgnoreAnthropicApiKeyCooldownForSandbox({
    sandboxApiKey: transport.apiKey,
    sharedAnthropicApiKey: params.anthropicApiKey,
    sandboxBaseUrl: transport.baseUrl,
  });
}

/**
 * True when credential lookup returned only a refreshable OAuth envelope
 * (no access token) — the post-auth_error path that hopes the CLI will refresh.
 */
export function isRefreshOnlyOauthEnvelope(
  credentialMeta: ClaudeCodeCredentialResult | null
): boolean {
  return (
    credentialMeta?.credentialMode === 'oauth_envelope' &&
    !credentialMeta.accessToken &&
    Boolean(credentialMeta.credentials)
  );
}

/**
 * Decide which auth env vars the Codex Code CLI sandbox should receive.
 *
 * Mirrors {@link resolveClaudeCodeAuthEnvs} (and the Rose completions fallback)
 * so the Codex code agent stays usable whenever an OAuth token would be:
 *   1. A synced/pool ChatGPT/Codex OAuth credential → CODEX_AUTH_JSON (primary).
 *      When a funded OpenAI key is also configured, it is injected ALONGSIDE the
 *      OAuth token as OPENAI_API_KEY so the sandbox can re-login and retry if the
 *      OAuth token hits `usage_limit_reached` MID-RUN. This is the real failure
 *      mode that stalled deploy: `fetchGptCodeCredentialsWithMeta` only filters
 *      tokens the DB already marked rate-limited, so a token that is over quota
 *      but not yet flagged is returned as valid and only fails at runtime inside
 *      the sandbox — where a null-credential fallback never gets a chance to fire.
 *   2. No OAuth credential (absent, or every pool token DB-rate-limited → null) →
 *      the funded OpenAI API key alone → OPENAI_API_KEY, which the sandbox
 *      ws-server logs in with via `codex login --with-api-key`.
 *   3. Otherwise throw — nothing usable.
 *
 * Pure + exported so the selection is unit-testable without spinning an E2B
 * sandbox (the real session path isn't otherwise reachable in tests).
 */
export function resolveCodexCodeAuthEnvs(
  credentialMeta: GptCodeCredentialEnvelopeResult | null,
  openaiApiKey: string | undefined,
  openaiApiKeyOnCooldown = false
): Record<string, string> {
  const fundedKey =
    !openaiApiKeyOnCooldown && openaiApiKey !== undefined && openaiApiKey !== ''
      ? openaiApiKey
      : undefined;
  if (credentialMeta) {
    const envs: Record<string, string> = { CODEX_AUTH_JSON: credentialMeta.credentials };
    if (fundedKey !== undefined) {
      envs.OPENAI_API_KEY = fundedKey;
    }
    return envs;
  }
  if (fundedKey !== undefined) {
    return { OPENAI_API_KEY: fundedKey };
  }
  // Same split as the Claude path: the credential-inventory breakdown is operator-only, because the
  // [REDACTED] route returns `error.message` verbatim to the API client.
  const detail =
    'No GPT Code credentials available: no synced user credentials, no available pool tokens, ' +
    `and no usable OPENAI_API_KEY (GPT_API_KEY) fallback (${
      openaiApiKey !== undefined && openaiApiKey !== ''
        ? 'configured but on its out-of-credits/bad-key cooldown'
        : 'not set'
    })`;
  log.error('Codex Code credential resolution failed', { detail });
  throw new CodeAgentCredentialError(CODE_AGENT_CREDENTIALS_UNAVAILABLE, detail);
}
