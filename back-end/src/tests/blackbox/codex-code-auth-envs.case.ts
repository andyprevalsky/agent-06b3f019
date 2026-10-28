import {
  CODE_AGENT_CREDENTIALS_UNAVAILABLE,
  CODEX_AZURE_DEFAULT_DEPLOYMENT,
  CodeAgentCredentialError,
  resolveCodexAzureFunding,
  resolveCodexCodeAuthEnvs,
} from '../../providers/claudeCodeSandboxAuth';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

// ── resolveCodexCodeAuthEnvs (pure auth-env selection) ───────────────────────
// The sandbox ws-server runs with CODEX_AUTH_JSON (user OAuth) when present and
// falls back to our Azure OpenAI deployment (AZURE_OPENAI_API_KEY +
// CODEX_AZURE_BASE_URL + CODEX_AZURE_MODEL, selected with -c model_provider).
// The OpenAI GPT_API_KEY is not funded (2026-10-28) and never reaches a sandbox.
const CODEX_OAUTH_META = {
  accessToken: 'sk-codex-oat-xxx',
  accountId: 'acct_123',
  source: 'pool',
  userId: 'u1',
  poolTokenId: 'p1',
  credentials: '{"tokens":{"access_token":"a","refresh_token":""}}',
} as unknown as Parameters<typeof resolveCodexCodeAuthEnvs>[0];

const AZURE = {
  apiKey: 'azure-test-key',
  baseUrl: 'https://rose-foundry-westus.openai.azure.com/openai/v1',
  deployment: 'gpt-5.6-terra',
};

export function testResolveCodexAuthEnvs_oauthPrimaryWithApiKeyRuntimeFallback() {
  const envs = resolveCodexCodeAuthEnvs(CODEX_OAUTH_META, AZURE);
  assert(
    envs.CODEX_AUTH_JSON === '{"tokens":{"access_token":"a","refresh_token":""}}',
    'CODEX_AUTH_JSON set (primary) when OAuth credential present'
  );
  // Injected ALONGSIDE the OAuth token so the sandbox can switch provider and
  // retry if OAuth hits usage_limit_reached or proves revoked mid-run.
  assert(envs.AZURE_OPENAI_API_KEY === AZURE.apiKey, 'Azure key injected as runtime fallback');
  assert(envs.CODEX_AZURE_BASE_URL === AZURE.baseUrl, 'Azure v1 base URL injected');
  assert(envs.CODEX_AZURE_MODEL === AZURE.deployment, 'Azure deployment injected');
  assert(envs.OPENAI_API_KEY === undefined, 'the unfunded OpenAI key never reaches a sandbox');
}

export function testResolveCodexAuthEnvs_oauthWithoutFundedKey() {
  const envs = resolveCodexCodeAuthEnvs(CODEX_OAUTH_META, null);
  assert(envs.CODEX_AUTH_JSON !== undefined, 'CODEX_AUTH_JSON set when OAuth credential present');
  assert(
    Object.keys(envs).length === 1,
    `only the OAuth credential when no Azure deployment is configured: ${Object.keys(envs).join(',')}`
  );
}

export function testResolveCodexAuthEnvs_apiKeyFallback() {
  const envs = resolveCodexCodeAuthEnvs(null, AZURE);
  assert(envs.CODEX_AUTH_JSON === undefined, 'no OAuth auth.json in the funded fallback');
  assert(
    envs.AZURE_OPENAI_API_KEY === AZURE.apiKey && envs.CODEX_AZURE_MODEL === AZURE.deployment,
    'falls back to the Azure deployment when no OAuth credential (token rate-limited/exhausted)'
  );
}

/**
 * `POST /api/codex-code-session/create` returns `error.message` verbatim in its 500 body, so the
 * credential-inventory breakdown must stay on `detail` (server logs only).
 */
export function testResolveCodexAuthEnvs_noCredsNoKeyThrows() {
  let error: unknown;
  try {
    resolveCodexCodeAuthEnvs(null, null);
  } catch (err) {
    error = err;
  }
  assert(error instanceof CodeAgentCredentialError, 'throws a credential error');
  const credentialError = error as CodeAgentCredentialError;
  assert(
    credentialError.message === CODE_AGENT_CREDENTIALS_UNAVAILABLE,
    `client-facing message must be redacted, got: ${credentialError.message}`
  );
  assert(
    credentialError.detail.includes('Azure Codex deployment'),
    `operator detail must name the missing fallback, got: ${credentialError.detail}`
  );
}

const FOUNDRY_ENV = [
  'AZURE_FOUNDRY_ENDPOINT',
  'AZURE_FOUNDRY_API_KEY',
  'AZURE_FOUNDRY_ENDPOINT_3',
  'AZURE_FOUNDRY_API_KEY_3',
  'CODEX_AZURE_FOUNDRY_HOST',
  'CODEX_AZURE_DEPLOYMENT',
] as const;

function withFoundryEnv(
  env: Partial<Record<(typeof FOUNDRY_ENV)[number], string>>,
  fn: () => void
) {
  const saved = Object.fromEntries(FOUNDRY_ENV.map((key) => [key, process.env[key]]));
  for (const key of FOUNDRY_ENV) delete process.env[key];
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    for (const key of FOUNDRY_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** The funding resolves from the AZURE_FOUNDRY_* region whose endpoint is the westus resource. */
export function testResolveCodexAzureFunding_selectsWestusRegion() {
  withFoundryEnv(
    {
      AZURE_FOUNDRY_ENDPOINT: 'https://other-resource.openai.azure.com',
      AZURE_FOUNDRY_API_KEY: 'other-key',
      AZURE_FOUNDRY_ENDPOINT_3: 'https://rose-foundry-westus.openai.azure.com/',
      AZURE_FOUNDRY_API_KEY_3: 'westus-key',
    },
    () => {
      const funding = resolveCodexAzureFunding();
      assert(funding !== null, 'westus region is configured');
      assert(funding.apiKey === 'westus-key', 'uses the westus key, not another region');
      assert(
        funding.baseUrl === 'https://rose-foundry-westus.openai.azure.com/openai/v1',
        `Azure v1 base URL, got ${funding.baseUrl}`
      );
      assert(funding.deployment === CODEX_AZURE_DEFAULT_DEPLOYMENT, 'default deployment');
    }
  );
  withFoundryEnv(
    {
      AZURE_FOUNDRY_ENDPOINT: 'https://other-resource.openai.azure.com',
      AZURE_FOUNDRY_API_KEY: 'other-key',
      CODEX_AZURE_FOUNDRY_HOST: 'other-resource.openai.azure.com',
      CODEX_AZURE_DEPLOYMENT: 'gpt-5.3-codex',
    },
    () => {
      const funding = resolveCodexAzureFunding();
      assert(
        funding?.apiKey === 'other-key' && funding.deployment === 'gpt-5.3-codex',
        'host and deployment overrides select another configured region'
      );
    }
  );
  withFoundryEnv(
    {
      AZURE_FOUNDRY_ENDPOINT: 'https://other-resource.openai.azure.com',
      AZURE_FOUNDRY_API_KEY: 'other-key',
    },
    () => {
      assert(resolveCodexAzureFunding() === null, 'no funding when the westus region is absent');
    }
  );
}
