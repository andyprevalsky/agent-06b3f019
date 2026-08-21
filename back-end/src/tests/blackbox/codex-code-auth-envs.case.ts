import {
  CODE_AGENT_CREDENTIALS_UNAVAILABLE,
  CodeAgentCredentialError,
  resolveCodexCodeAuthEnvs,
} from '../../providers/e2b';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
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

export function testResolveCodexAuthEnvs_oauthPrimaryWithApiKeyRuntimeFallback() {
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

export function testResolveCodexAuthEnvs_oauthWithoutFundedKey() {
  const envs = resolveCodexCodeAuthEnvs(CODEX_OAUTH_META, undefined);
  assert(
    envs.CODEX_AUTH_JSON === '{"tokens":{"access_token":"a","refresh_token":"r"}}',
    'CODEX_AUTH_JSON set when OAuth credential present and no funded key'
  );
  assert(envs.OPENAI_API_KEY === undefined, 'no OPENAI_API_KEY when funded key is not configured');
}

export function testResolveCodexAuthEnvs_apiKeyFallback() {
  const envs = resolveCodexCodeAuthEnvs(null, 'sk-proj-funded-key');
  assert(
    envs.OPENAI_API_KEY === 'sk-proj-funded-key',
    'falls back to OPENAI_API_KEY when no OAuth credential (e.g. token rate-limited/exhausted)'
  );
  assert(envs.CODEX_AUTH_JSON === undefined, 'no OAuth auth.json in fallback');
}

/**
 * `POST /api/codex-code-session/create` returns `error.message` verbatim in its 500 body, so the
 * credential-inventory breakdown must stay on `detail` (server logs only).
 */
function assertRedactedCredentialThrow(run: () => unknown, label: string): void {
  let error: unknown;
  try {
    run();
  } catch (err) {
    error = err;
  }
  assert(error instanceof CodeAgentCredentialError, `${label}: throws a credential error`);
  const credentialError = error as CodeAgentCredentialError;
  assert(
    credentialError.message === CODE_AGENT_CREDENTIALS_UNAVAILABLE,
    `${label}: client-facing message must be redacted, got: ${credentialError.message}`
  );
  assert(
    !credentialError.message.includes('OPENAI_API_KEY') &&
      !credentialError.message.includes('pool tokens'),
    `${label}: client-facing message must not disclose credential state`
  );
  assert(
    credentialError.detail.includes('OPENAI_API_KEY (GPT_API_KEY)'),
    `${label}: operator detail must still name the missing fallback, got: ${credentialError.detail}`
  );
}

export function testResolveCodexAuthEnvs_noCredsNoKeyThrows() {
  assertRedactedCredentialThrow(
    () => resolveCodexCodeAuthEnvs(null, undefined),
    'no OAuth credential and no OPENAI_API_KEY fallback configured'
  );
}

export function testResolveCodexAuthEnvs_emptyKeyThrows() {
  assertRedactedCredentialThrow(
    () => resolveCodexCodeAuthEnvs(null, ''),
    'api-key fallback is an empty string'
  );
}

export function testResolveCodexAuthEnvs_cooldownExcludesFundedKey() {
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
