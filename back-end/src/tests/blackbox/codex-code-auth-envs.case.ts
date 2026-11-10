import {
  CODE_AGENT_CREDENTIALS_UNAVAILABLE,
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
  baseUrl: 'https://rose-foundry-southcentralus.openai.azure.com/openai/v1',
  deployment: 'gpt-6.1-sol',
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
  'AZURE_FOUNDRY_DEPLOYMENTS',
  'AZURE_FOUNDRY_ENDPOINT_2',
  'AZURE_FOUNDRY_API_KEY_2',
  'AZURE_FOUNDRY_DEPLOYMENTS_2',
  'AZURE_FOUNDRY_ENDPOINT_3',
  'AZURE_FOUNDRY_API_KEY_3',
  'AZURE_FOUNDRY_DEPLOYMENTS_3',
  'AZURE_FOUNDRY_ENDPOINT_4',
  'AZURE_FOUNDRY_API_KEY_4',
  'AZURE_FOUNDRY_DEPLOYMENTS_4',
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

/** The production region layout (deployment names only; keys are fakes). */
const PROD_LAYOUT = {
  AZURE_FOUNDRY_ENDPOINT: 'https://a-4989-resource.openai.azure.com',
  AZURE_FOUNDRY_API_KEY: 'region-1-key',
  AZURE_FOUNDRY_DEPLOYMENTS: 'gpt-6-sol',
  AZURE_FOUNDRY_ENDPOINT_2: 'https://rose-foundry-southcentralus.openai.azure.com',
  AZURE_FOUNDRY_API_KEY_2: 'southcentralus-key',
  AZURE_FOUNDRY_DEPLOYMENTS_2: 'gpt-6.1-sol',
  AZURE_FOUNDRY_ENDPOINT_3: 'https://rose-foundry-westus.openai.azure.com/',
  AZURE_FOUNDRY_API_KEY_3: 'westus-key',
  AZURE_FOUNDRY_DEPLOYMENTS_3: 'gpt-6-sol',
  AZURE_FOUNDRY_ENDPOINT_4: 'https://rose-foundry-southcentralus.openai.azure.com/',
  AZURE_FOUNDRY_API_KEY_4: 'southcentralus-4-key',
  AZURE_FOUNDRY_DEPLOYMENTS_4: 'gpt-6-sol',
} as const;

/**
 * Both tiers fund Codex from gpt-6.1-sol: the first region whose deployment list
 * names it (southcentralus, slot 2), read from AZURE_FOUNDRY_*, never a fixed host.
 */
export function testResolveCodexAzureFunding_selectsRegionByDeployment() {
  withFoundryEnv(PROD_LAYOUT, () => {
    for (const tier of ['ultra', 'flash'] as const) {
      const funding = resolveCodexAzureFunding(tier);
      assert(funding !== null, `${tier}: a region lists gpt-6.1-sol`);
      assert(funding.apiKey === 'southcentralus-key', `${tier}: slot 2 key, got another region`);
      assert(
        funding.baseUrl === 'https://rose-foundry-southcentralus.openai.azure.com/openai/v1',
        `${tier}: Azure v1 base URL, got ${funding.baseUrl}`
      );
      assert(funding.deployment === 'gpt-6.1-sol', `${tier}: deployment ${funding.deployment}`);
    }
  });
  // Overrides still win: the deployment by name, the resource by host.
  withFoundryEnv({ ...PROD_LAYOUT, CODEX_AZURE_DEPLOYMENT: 'gpt-6-sol' }, () => {
    const funding = resolveCodexAzureFunding('ultra');
    assert(
      funding?.apiKey === 'region-1-key' && funding.deployment === 'gpt-6-sol',
      'CODEX_AZURE_DEPLOYMENT picks the first region listing it'
    );
  });
  withFoundryEnv(
    {
      ...PROD_LAYOUT,
      CODEX_AZURE_FOUNDRY_HOST: 'rose-foundry-westus.openai.azure.com',
      CODEX_AZURE_DEPLOYMENT: 'gpt-5.6-terra',
    },
    () => {
      const funding = resolveCodexAzureFunding('flash');
      assert(
        funding?.apiKey === 'westus-key' && funding.deployment === 'gpt-5.6-terra',
        'CODEX_AZURE_FOUNDRY_HOST pins the resource even when its list omits the deployment'
      );
    }
  );
  withFoundryEnv(
    {
      AZURE_FOUNDRY_ENDPOINT: PROD_LAYOUT.AZURE_FOUNDRY_ENDPOINT,
      AZURE_FOUNDRY_API_KEY: 'region-1-key',
      AZURE_FOUNDRY_DEPLOYMENTS: 'gpt-6-sol',
      AZURE_FOUNDRY_ENDPOINT_2: 'http://rose-foundry-southcentralus.openai.azure.com',
      AZURE_FOUNDRY_API_KEY_2: 'insecure-key',
      AZURE_FOUNDRY_DEPLOYMENTS_2: 'gpt-6.1-sol',
    },
    () => {
      assert(
        resolveCodexAzureFunding() === null,
        'no funding when only a non-HTTPS region lists gpt-6.1-sol'
      );
    }
  );
}
