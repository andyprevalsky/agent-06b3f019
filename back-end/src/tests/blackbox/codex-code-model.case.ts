/**
 * Code-agent CLI model, effort and speed per parent tier (codeAgentModels.ts).
 *
 *   POST /api/agents { model, fast_mode_cache_enabled }
 *        │  stored on Agent.model / Agent.fastModeCacheEnabled
 *        ▼
 *   codeAgentSettingsForAgent(agentId) ──► { tier, speed }
 *        ├─► claudeCodeSettingsEnvs ──► CLAUDE_CODE_MODEL / _EFFORT / _SPEED
 *        ├─► codexCodeSettingsEnvs  ──► CODEX_MODEL / CODEX_REASONING_EFFORT / CODEX_SPEED
 *        └─► Azure (inspectCliArgs)  ──► service_tier="priority" only when fast
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CODE_AGENT_CLI_MODELS,
  claudeCodeSettingsEnvs,
  codeAgentSettingsForAgent,
  codeAgentSpeed,
  codeAgentTier,
  codexAzureDeployment,
  codexCodeSettingsEnvs,
} from '../../providers/codeAgentModels';
import { inspectCliArgs, inspectPaths } from '../../providers/codeSessions/inspectSandbox';
import { prisma } from '../../providers/database';
import { assert, assertStatus, request } from './codex-sandbox.support';

/** Claude Code may attempt fast mode (Anthropic rejects/falls back by quota). */
const CLAUDE_FAST = {
  CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS: '1',
  CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: '1',
};

const OVERRIDES = [
  'CLAUDE_CODE_MODEL',
  'CODEX_CODE_MODEL',
  'CODEX_AZURE_DEPLOYMENT',
  'CLAUDE_CODE_EFFORT',
  'CODEX_REASONING_EFFORT',
] as const;

function withOverrides(env: Partial<Record<(typeof OVERRIDES)[number], string>>, fn: () => void) {
  const saved = Object.fromEntries(OVERRIDES.map((key) => [key, process.env[key]]));
  for (const key of OVERRIDES) delete process.env[key];
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    for (const key of OVERRIDES) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function same(actual: unknown, expected: unknown, message: string) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`
  );
}

/** Tier × provider: both tiers run Opus 5.5 / GPT-6.1 Sol; ultra at xhigh, flash at medium. */
export function testCodeAgentModels_tierTableAndUnknownIsFlash() {
  withOverrides({}, () => {
    same(
      claudeCodeSettingsEnvs({ tier: 'ultra', speed: 'fast' }),
      {
        CLAUDE_CODE_MODEL: 'claude-opus-5-5',
        CLAUDE_CODE_EFFORT: 'xhigh',
        CLAUDE_CODE_SPEED: 'fast',
        ...CLAUDE_FAST,
      },
      'ultra Claude'
    );
    // Claude has no ultrafast: fast mode for fast or ultrafast.
    same(
      claudeCodeSettingsEnvs({ tier: 'flash', speed: 'ultrafast' }),
      {
        CLAUDE_CODE_MODEL: 'claude-opus-5-5',
        CLAUDE_CODE_EFFORT: 'medium',
        CLAUDE_CODE_SPEED: 'fast',
        ...CLAUDE_FAST,
      },
      'ultrafast Claude is fast mode'
    );
    same(
      codexCodeSettingsEnvs({ tier: 'ultra', speed: 'ultrafast' }),
      { CODEX_MODEL: 'gpt-6.1-sol', CODEX_REASONING_EFFORT: 'xhigh', CODEX_SPEED: 'ultrafast' },
      'ultrafast Codex request'
    );
    same(
      claudeCodeSettingsEnvs({ tier: 'flash', speed: 'standard' }),
      {
        CLAUDE_CODE_MODEL: 'claude-opus-5-5',
        CLAUDE_CODE_EFFORT: 'medium',
        CLAUDE_CODE_SPEED: 'standard',
      },
      'flash Claude'
    );
    same(
      codexCodeSettingsEnvs({ tier: 'ultra', speed: 'fast' }),
      { CODEX_MODEL: 'gpt-6.1-sol', CODEX_REASONING_EFFORT: 'xhigh', CODEX_SPEED: 'fast' },
      'ultra Codex'
    );
    same(
      codexCodeSettingsEnvs({ tier: 'flash', speed: 'standard' }),
      { CODEX_MODEL: 'gpt-6.1-sol', CODEX_REASONING_EFFORT: 'medium', CODEX_SPEED: 'standard' },
      'flash Codex'
    );
    for (const tier of ['ultra', 'flash'] as const) {
      assert(codexAzureDeployment(tier) === 'gpt-6.1-sol', `${tier} Azure deployment`);
    }
    // Unknown / other tiers are flash; only Rose Ultra is ultra.
    for (const model of ['rose-labs/rose-1-ultra', 'rose-1-ultra', ' Rose-Labs/Rose-1-Ultra ']) {
      assert(codeAgentTier(model) === 'ultra', `${model} is ultra`);
    }
    for (const model of ['rose-labs/rose-1-flash', 'rose-labs/rose-1-mini', '', null, undefined]) {
      assert(codeAgentTier(model) === 'flash', `${String(model)} is flash`);
    }
    // The Fast Mode button is the speed request; an unknown agent keeps Rose's default (on).
    same(
      [codeAgentSpeed(true), codeAgentSpeed(false), codeAgentSpeed(null)],
      ['fast', 'standard', 'fast'],
      'speed from the Fast Mode button'
    );
  });
}

/** Explicit env overrides win over every tier. */
export function testCodeAgentModels_overridesWin() {
  withOverrides(
    {
      CLAUDE_CODE_MODEL: 'claude-sonnet-5',
      CODEX_CODE_MODEL: 'gpt-5.6-terra',
      CODEX_AZURE_DEPLOYMENT: 'gpt-6-sol',
      CLAUDE_CODE_EFFORT: 'low',
      CODEX_REASONING_EFFORT: 'high',
    },
    () => {
      for (const tier of ['ultra', 'flash'] as const) {
        same(
          claudeCodeSettingsEnvs({ tier, speed: 'fast' }),
          {
            CLAUDE_CODE_MODEL: 'claude-sonnet-5',
            CLAUDE_CODE_EFFORT: 'low',
            CLAUDE_CODE_SPEED: 'fast',
            ...CLAUDE_FAST,
          },
          `${tier} Claude overrides`
        );
        same(
          codexCodeSettingsEnvs({ tier, speed: 'standard' }),
          { CODEX_MODEL: 'gpt-5.6-terra', CODEX_REASONING_EFFORT: 'high', CODEX_SPEED: 'standard' },
          `${tier} Codex overrides`
        );
        assert(codexAzureDeployment(tier) === 'gpt-6-sol', `${tier} Azure override`);
      }
    }
  );
}

/** ws-server fallbacks (no model env from the backend) equal the flash row. */
export function testCodeAgentModels_wsServerFallbacksMatchFlash() {
  const root = join(process.cwd(), '..', 'e2b-templates');
  const codex = readFileSync(join(root, 'codex-code', 'ws-server.mjs'), 'utf8');
  const claude = readFileSync(join(root, 'claude-code', 'ws-server.mjs'), 'utf8');
  const flash = CODE_AGENT_CLI_MODELS.flash;
  assert(
    codex.includes(`const CODEX_MODEL = process.env.CODEX_MODEL || "${flash.codex}";`),
    'Codex ws-server fallback is the flash Codex model'
  );
  assert(
    claude.includes(
      `const CLAUDE_CODE_MODEL = process.env.CLAUDE_CODE_MODEL || "${flash.claude}";`
    ),
    'Claude ws-server fallback is the flash Claude model'
  );
  const catalog = JSON.parse(
    readFileSync(join(root, 'codex-code', 'azure-model-catalog.json'), 'utf8')
  ) as { models: { slug: string; service_tiers: { id: string }[] }[] };
  const entry = catalog.models.find((model) => model.slug === flash.codexAzure);
  same(
    entry?.service_tiers.map((tier) => tier.id),
    ['priority'],
    'the Azure catalog describes the Azure deployment with priority only'
  );
}

/** The Azure (and ChatGPT) exec request names priority only for a fast agent. */
export function testCodeAgentModels_inspectAzureTierFollowsSpeed() {
  const paths = inspectPaths('/home/user');
  const args = (codexSpeed: 'standard' | 'fast' | 'ultrafast') =>
    inspectCliArgs(
      {
        provider: 'codex',
        workDir: '/home/user/workspace',
        model: 'gpt-6.1-sol',
        timeoutS: 60,
        codexAzureBaseUrl: 'https://rose-foundry-southcentralus.openai.azure.com/openai/v1',
        codexAzureModelCatalog: true,
        codexEffort: 'xhigh',
        codexSpeed,
      },
      paths
    );
  for (const speed of ['fast', 'ultrafast'] as const) {
    assert(args(speed).includes('service_tier="priority"'), `${speed} asks Azure for priority`);
  }
  assert(
    !args('standard').some((arg) => arg.startsWith('service_tier=')),
    'standard sends no tier'
  );
  const fast = args('fast');
  assert(fast.includes('model_reasoning_effort="xhigh"'), 'the tier effort reaches the CLI');
  assert(
    fast.includes(`model_catalog_json=${JSON.stringify(paths.codexAzureModelCatalog)}`),
    'the Azure catalog is loaded'
  );
}

/**
 * Speed comes from the create-agent request: an API caller (no frontend) sets
 * `fast_mode_cache_enabled` and `model`; the stored agent then decides what
 * every code agent it spawns runs, including Azure's priority tier.
 */
export async function testCodeAgentModels_createAgentRequestReachesCodeAgent(
  baseUrl: string,
  headers: Record<string, string>
) {
  const cases = [
    { model: 'rose-labs/rose-1-ultra', fast: true, effort: 'xhigh', speed: 'fast', claude: 'fast' },
    {
      model: 'rose-labs/rose-1-flash',
      fast: false,
      effort: 'medium',
      speed: 'standard',
      claude: 'standard',
    },
  ] as const;
  for (const c of cases) {
    const created = await request(`${baseUrl}/api/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        goal: `code-agent speed blackbox ${c.model} ${crypto.randomUUID()}`,
        model: c.model,
        fast_mode_cache_enabled: c.fast,
      }),
    });
    assertStatus(created.status, 201, created.data);
    const agentId = (created.data as { agent_id: string }).agent_id;
    try {
      const stored = await prisma.agent.findUniqueOrThrow({
        where: { id: agentId },
        select: { model: true, fastModeCacheEnabled: true },
      });
      same(stored, { model: c.model, fastModeCacheEnabled: c.fast }, 'the request is stored');
      const settings = await codeAgentSettingsForAgent(agentId);
      withOverrides({}, () => {
        same(
          codexCodeSettingsEnvs(settings),
          { CODEX_MODEL: 'gpt-6.1-sol', CODEX_REASONING_EFFORT: c.effort, CODEX_SPEED: c.speed },
          `${c.model} Codex sandbox env`
        );
        same(
          claudeCodeSettingsEnvs(settings),
          {
            CLAUDE_CODE_MODEL: 'claude-opus-5-5',
            CLAUDE_CODE_EFFORT: c.effort,
            CLAUDE_CODE_SPEED: c.claude,
            ...(c.fast ? CLAUDE_FAST : {}),
          },
          `${c.model} Claude sandbox env`
        );
      });
      const azure = inspectCliArgs(
        {
          provider: 'codex',
          workDir: '/home/user/workspace',
          model: codexAzureDeployment(settings.tier),
          timeoutS: 60,
          codexAzureBaseUrl: 'https://rose-foundry-southcentralus.openai.azure.com/openai/v1',
          codexSpeed: settings.speed,
        },
        inspectPaths('/home/user')
      );
      assert(
        azure.includes('service_tier="priority"') === c.fast,
        `${c.model}: Azure priority ${c.fast ? 'on' : 'off'}`
      );
    } finally {
      await request(`${baseUrl}/api/agents/${agentId}`, { method: 'DELETE', headers });
    }
  }
}
