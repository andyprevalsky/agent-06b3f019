/**
 * Agent speed: the create-agent `speed` param forwarded to every provider leg.
 *
 *   create-agent { speed } ──► Agent.speed ──► Rose leg request body
 *     standard   → nothing (no speed / service_tier anywhere)
 *     fast       → Claude `speed: fast` (fast-mode models only),
 *                  GPT OAuth / OpenAI key `service_tier: priority`,
 *                  Azure Foundry `service_tier: priority`, OpenRouter `speed: fast`
 *     ultrafast  → as fast, except GPT OAuth / OpenAI key send
 *                  `service_tier: ultrafast` on models whose catalog lists it.
 *                  Claude has no ultrafast: it gets fast mode. Azure has no
 *                  ultrafast: it gets priority.
 *
 * Speed never gates a cache. Mirror: agents/providers/rose/speed.py.
 */

export const AGENT_SPEEDS = ['standard', 'fast', 'ultrafast'] as const;
export type AgentSpeed = (typeof AGENT_SPEEDS)[number];

/**
 * Claude API fast mode (`speed: "fast"` + `fast-mode-2026-02-01` beta). Claude
 * API reference 2026-10-06: Claude Opus 5, Claude Opus 5.5 and Opus 4.8 only;
 * Opus 4.7 fast mode was removed and now errors.
 */
const ANTHROPIC_FAST_MODE_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8']);

/**
 * Models whose ChatGPT/Codex catalog lists the `ultrafast` service tier
 * (live catalog fetched 2026-10-28: gpt-6.1-sol and gpt-6-astra list
 * `priority` + `ultrafast`; every other GPT model lists `priority` only).
 */
const OPENAI_ULTRAFAST_MODELS = new Set(['gpt-6.1-sol', 'gpt-6-astra']);

export function isAgentSpeed(value: unknown): value is AgentSpeed {
  return typeof value === 'string' && (AGENT_SPEEDS as readonly string[]).includes(value);
}

/** Unknown/absent values are standard: a call without an agent runs at standard. */
export function normalizeAgentSpeed(value: unknown): AgentSpeed {
  return isAgentSpeed(value) ? value : 'standard';
}

/**
 * Speed persisted on an Agent row. Rows that predate the column carry null and
 * keep the speed their legacy Fast Mode button gave them (true → fast).
 */
export function agentSpeedFromRow(row: {
  speed?: string | null;
  fastModeCacheEnabled?: boolean | null;
}): AgentSpeed {
  if (isAgentSpeed(row.speed)) return row.speed;
  return row.fastModeCacheEnabled === true ? 'fast' : 'standard';
}

function isFastOrUltrafast(speed: AgentSpeed | undefined): boolean {
  return speed === 'fast' || speed === 'ultrafast';
}

export function supportsAnthropicFastMode(model: string): boolean {
  return ANTHROPIC_FAST_MODE_MODELS.has(model);
}

/** Claude legs (OAuth and API key): `speed: "fast"` for fast or ultrafast. */
export function anthropicSpeedFor(
  speed: AgentSpeed | undefined,
  model: string
): 'fast' | undefined {
  return isFastOrUltrafast(speed) && supportsAnthropicFastMode(model) ? 'fast' : undefined;
}

/** GPT OAuth (Codex) and OpenAI API key legs. */
export function openAiServiceTierFor(
  speed: AgentSpeed | undefined,
  model: string
): 'priority' | 'ultrafast' | undefined {
  if (speed === 'ultrafast') {
    return OPENAI_ULTRAFAST_MODELS.has(model) ? 'ultrafast' : 'priority';
  }
  return speed === 'fast' ? 'priority' : undefined;
}

/** Azure Foundry has no ultrafast tier: fast and ultrafast both send priority. */
export function foundryServiceTierFor(speed: AgentSpeed | undefined): 'priority' | undefined {
  return isFastOrUltrafast(speed) ? 'priority' : undefined;
}

/** OpenRouter waterfall keeps its existing `speed: "fast"` hint for fast/ultrafast. */
export function openRouterSpeedFor(speed: AgentSpeed | undefined): 'fast' | undefined {
  return isFastOrUltrafast(speed) ? 'fast' : undefined;
}
