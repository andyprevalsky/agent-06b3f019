/**
 * What a code agent's CLI runs: model and effort per parent tier, speed from
 * the parent's stored speed. One table for every path: E2B spawn and
 * resume (e2b.ts), the provider switch (it creates the other provider's session
 * the same way), the inspector (codeSessions/inspect.ts), local devices
 * (localDevices/session.ts) and the funded paths (the Anthropic key runs the
 * same Claude model; Azure serves `codexAzure`, claudeCodeSandboxAuth.ts).
 *
 *   spawning Agent.model ──► tier ──► { claude, codex, codexAzure, effort }
 *   rose-labs/rose-1-ultra   ultra    opus 5.5 / gpt-6.1-sol / gpt-6.1-sol / xhigh
 *   anything else, unknown   flash    opus 5.5 / gpt-6.1-sol / gpt-6.1-sol / medium
 *
 *   spawning agent's stored speed (storedAgentSpeed) ──► speed request
 *   standard | fast | ultrafast; legacy rows use agentSpeedFromRow's migration policy
 *
 * Speed only selects provider speed; it never turns a cache on (the Fast Mode
 * tee-proxy keeps its own DEMO-cache gate in e2b.ts). Each ws-server maps the
 * request onto the CLI's own catalog: Claude fast mode for fast or ultrafast
 * when supportsFastMode (Claude has no ultrafast); Codex on a ChatGPT login
 * fast -> priority ("Fast") and ultrafast -> ultrafast where offered (else
 * priority); the funded Azure provider sends priority for either, nothing for
 * standard.
 *
 * CLAUDE_CODE_MODEL / CODEX_CODE_MODEL / CODEX_AZURE_DEPLOYMENT and
 * CLAUDE_CODE_EFFORT / CODEX_REASONING_EFFORT override every tier. The
 * ws-server fallbacks (no model env) equal the flash row; codex-code-model.case.ts
 * pins them.
 */
import { prisma } from './database';
import { agentSpeedFromRow, normalizeAgentSpeed } from './rose/speed';

export type CodeAgentTier = 'ultra' | 'flash';
/** Speed a code agent requests, from its spawning agent's stored speed. */
export type CodeAgentSpeed = 'standard' | 'fast' | 'ultrafast';

export interface CodeAgentCliProfile {
  claude: string;
  codex: string;
  codexAzure: string;
  effort: string;
}

export const CODE_AGENT_CLI_MODELS: Readonly<Record<CodeAgentTier, CodeAgentCliProfile>> = {
  ultra: {
    claude: 'claude-opus-5-5',
    codex: 'gpt-6.1-sol',
    codexAzure: 'gpt-6.1-sol',
    effort: 'xhigh',
  },
  flash: {
    claude: 'claude-opus-5-5',
    codex: 'gpt-6.1-sol',
    codexAzure: 'gpt-6.1-sol',
    effort: 'medium',
  },
};

/** The parent agent's tier from its model; anything but Rose Ultra (or unknown) is flash. */
export function codeAgentTier(parentModel: string | null | undefined): CodeAgentTier {
  const pool = (parentModel ?? '')
    .trim()
    .toLowerCase()
    .replace(/^rose-labs\//, '');
  return pool === 'rose-1-ultra' ? 'ultra' : 'flash';
}

/** Unknown/absent requests are standard; never infer speed from a cache. */
export function codeAgentSpeed(speed: unknown): CodeAgentSpeed {
  return normalizeAgentSpeed(speed);
}

export interface CodeAgentSettings {
  tier: CodeAgentTier;
  speed: CodeAgentSpeed;
}

/** Agent columns the code-agent settings read. */
const SETTINGS_SELECT = { model: true, speed: true, fastModeCacheEnabled: true } as const;

/** Stored speed, sharing the speed tree's legacy-row migration policy. */
export function storedAgentSpeed(
  agent: { speed?: string | null; fastModeCacheEnabled?: boolean | null } | null | undefined
): CodeAgentSpeed {
  return agent ? agentSpeedFromRow(agent) : 'standard';
}

/** Tier and speed of the agent that spawns the code agent; flash + standard when unknown. */
export async function codeAgentSettingsForAgent(
  agentId: string | null | undefined
): Promise<CodeAgentSettings> {
  const agent = agentId
    ? await prisma.agent.findUnique({ where: { id: agentId }, select: SETTINGS_SELECT })
    : null;
  return { tier: codeAgentTier(agent?.model), speed: storedAgentSpeed(agent) };
}

function override(name: string): string {
  return (process.env[name] ?? '').trim();
}

/** Claude Code CLI model: CLAUDE_CODE_MODEL when set, else the tier's. */
export function claudeCodeModel(tier: CodeAgentTier = 'flash'): string {
  return override('CLAUDE_CODE_MODEL') || CODE_AGENT_CLI_MODELS[tier].claude;
}

/** Codex CLI model on a ChatGPT login: CODEX_CODE_MODEL when set, else the tier's. */
export function codexCodeModel(tier: CodeAgentTier = 'flash'): string {
  return override('CODEX_CODE_MODEL') || CODE_AGENT_CLI_MODELS[tier].codex;
}

/** Azure deployment that funds Codex: CODEX_AZURE_DEPLOYMENT when set, else the tier's. */
export function codexAzureDeployment(tier: CodeAgentTier = 'flash'): string {
  return override('CODEX_AZURE_DEPLOYMENT') || CODE_AGENT_CLI_MODELS[tier].codexAzure;
}

/** Claude Code effort: CLAUDE_CODE_EFFORT when set, else the tier's. */
export function claudeCodeEffort(tier: CodeAgentTier = 'flash'): string {
  return override('CLAUDE_CODE_EFFORT') || CODE_AGENT_CLI_MODELS[tier].effort;
}

/** Codex reasoning effort: CODEX_REASONING_EFFORT when set, else the tier's. */
export function codexCodeEffort(tier: CodeAgentTier = 'flash'): string {
  return override('CODEX_REASONING_EFFORT') || CODE_AGENT_CLI_MODELS[tier].effort;
}

/** Sandbox env naming the Claude Code CLI model, effort and speed request. */
export function claudeCodeSettingsEnvs(settings: CodeAgentSettings): Record<string, string> {
  const fast = settings.speed !== 'standard';
  return {
    CLAUDE_CODE_MODEL: claudeCodeModel(settings.tier),
    CLAUDE_CODE_EFFORT: claudeCodeEffort(settings.tier),
    // Claude has no ultrafast: fast mode for either; ws-server turns it on only
    // when the native catalog supportsFastMode.
    CLAUDE_CODE_SPEED: fast ? 'fast' : 'standard',
    // Let the CLI attempt fast mode so Anthropic can reject/fall back by quota.
    ...(fast
      ? {
          CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS: '1',
          CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: '1',
        }
      : {}),
  };
}

/** Sandbox env naming the Codex CLI model, effort and speed request (ChatGPT login). */
export function codexCodeSettingsEnvs(settings: CodeAgentSettings): Record<string, string> {
  return {
    CODEX_MODEL: codexCodeModel(settings.tier),
    CODEX_REASONING_EFFORT: codexCodeEffort(settings.tier),
    // ws-server maps the request onto the catalog's tiers (Azure: priority).
    CODEX_SPEED: settings.speed,
  };
}

/**
 * Model / effort / speed the person picked for a resuming turn
 * (claude-code-session create `cli_settings`): they replace the agent tier's
 * values for that run, so the first resumed turn runs on them.
 */
export interface CodeCliSettingsOverride {
  model?: string;
  reasoning_effort?: string;
  speed?: string;
}

export function cliSettingsEnvOverrides(
  provider: 'claude' | 'codex',
  override: CodeCliSettingsOverride | null | undefined
): Record<string, string> {
  if (!override) return {};
  const keys =
    provider === 'claude'
      ? { model: 'CLAUDE_CODE_MODEL', effort: 'CLAUDE_CODE_EFFORT', speed: 'CLAUDE_CODE_SPEED' }
      : { model: 'CODEX_MODEL', effort: 'CODEX_REASONING_EFFORT', speed: 'CODEX_SPEED' };
  const envs: Record<string, string> = {};
  if (override.model) envs[keys.model] = override.model;
  if (override.reasoning_effort) envs[keys.effort] = override.reasoning_effort;
  if (override.speed) {
    // Claude has no ultrafast/priority tier: any non-standard pick is fast mode.
    // Codex's "fast" tier is `priority` (codexSpeedFor); a Codex pick of
    // priority/ultrafast/standard passes through unchanged.
    envs[keys.speed] =
      provider === 'claude'
        ? override.speed === 'standard'
          ? 'standard'
          : 'fast'
        : override.speed === 'fast'
          ? 'priority'
          : override.speed;
  }
  return envs;
}

/** The spawning agent's settings and the provider's sandbox env for them. */
export async function codeAgentCliEnvs(
  provider: 'claude' | 'codex',
  agentId: string | null | undefined,
  override?: CodeCliSettingsOverride | null
): Promise<{
  settings: CodeAgentSettings;
  envs: Record<string, string>;
  /** The person's resuming-turn speed, already in the provider's terms; null without one. */
  speedOverride: string | null;
}> {
  const settings = await codeAgentSettingsForAgent(agentId);
  const envs =
    provider === 'claude' ? claudeCodeSettingsEnvs(settings) : codexCodeSettingsEnvs(settings);
  const overrides = cliSettingsEnvOverrides(provider, override);
  const speedOverride = overrides[provider === 'claude' ? 'CLAUDE_CODE_SPEED' : 'CODEX_SPEED'];
  return { settings, envs: { ...envs, ...overrides }, speedOverride: speedOverride ?? null };
}
