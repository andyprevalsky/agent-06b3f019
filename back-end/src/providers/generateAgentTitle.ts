/**
 * Short sidebar-title generation for newly spawned agents.
 *
 * Why this exists: the sidebar used to render the raw `goal`, which is often a
 * paragraph. A 2-5 word label makes a list of runs scannable the way a file
 * tree is. The user can override it at any time via rename (PATCH
 * /api/agents/:id { title }), and this generator never overwrites an existing
 * title — so a rename is permanent even if generation lands afterwards.
 *
 * Shape mirrors providers/setResponseSchema.ts: fire-and-forget from the create
 * path, Rose Lite, retryWithBackoff, and non-retryable on auth/bad-request. A
 * failure is not an error state — `title` stays null and the UI falls back to
 * `goal`.
 *
 * At 10k concurrent agents this is one short Lite call per ROOT agent (sub-agents
 * never appear in the sidebar and are skipped), with no shared state and no
 * fan-in: cost scales with agents created, and each call is independent.
 */

import { prisma } from './database';
import { createLogger } from './logger';
import { retryWithBackoff } from './retry';
import { createStreamingCompletion, RoseAuthError, RoseInvalidRequest } from './rose';

const log = createLogger('AgentTitle');

/** Hard cap on the stored title. Matches updateAgentSchema's max(80). */
export const AGENT_TITLE_MAX_CHARS = 80;

/** Soft target handed to the model — shorter than the hard cap so it aims low. */
const TITLE_TARGET_CHARS = 48;

const SYSTEM_PROMPT = `You write short sidebar labels for background agent runs.

Given the agent's goal, return a label a person can scan in a list.

Rules:
- 2 to 5 words.
- Title Case.
- No trailing punctuation, no quotes, no markdown.
- At most ${TITLE_TARGET_CHARS} characters.
- Name the concrete subject of the task, not the act of doing it.

Good:
  goal: "find me a good sushi restaurant in soho for saturday night and book a table for 4"
  label: Soho Sushi Reservation
  goal: "P1: the browser agent keeps stalling on cloudflare turnstile, figure out why"
  label: Browser Agent Stall
  goal: "what is 2+2"
  label: Simple Arithmetic

Bad (too generic — never do this):
  Task, Agent Run, User Request, Doing Research, Handling It

Return ONLY the label.`;

/** Raised when a stream produced nothing usable — worth another attempt. */
class EmptyTitleError extends Error {
  constructor() {
    super('Title generation produced no usable label');
    this.name = 'EmptyTitleError';
  }
}

function isRetryableTitleError(error: unknown): boolean {
  // Auth / bad-request are configuration problems, not transient ones — burning
  // retries on them just delays the (harmless) give-up.
  return !(error instanceof RoseAuthError || error instanceof RoseInvalidRequest);
}

/**
 * Normalize a model response into a storable title.
 *
 * The model occasionally wraps the label in quotes, prefixes it with `Label:`,
 * or appends a period despite the prompt. Returns null when nothing usable is
 * left, which the caller treats as "leave title null".
 */
export function normalizeTitle(raw: string): string | null {
  const firstLine = raw.trim().split('\n')[0] ?? '';
  const cleaned = firstLine
    .replace(/^\s*(?:label|title)\s*:\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.,;:!]+$/, '')
    .trim();

  if (cleaned === '') return null;
  return cleaned.length > AGENT_TITLE_MAX_CHARS
    ? cleaned.slice(0, AGENT_TITLE_MAX_CHARS).trimEnd()
    : cleaned;
}

/* c8 ignore start -- requires a live Rose provider */
/**
 * Single Rose Lite call returning the raw label text.
 *
 * Plain `delta.content` accumulation on purpose. StructuredOutputAccumulator is
 * for phased/structured responses paired with a json_schema response_format —
 * pointed at a free-text completion it either finds no eligible item (throwing
 * a cardinality error) or picks one fragment, which truncated
 * "Soho Sushi Reservation" down to "Soho".
 */
async function requestTitle(goal: string): Promise<string> {
  const stream = await createStreamingCompletion({
    model: 'rose-labs/rose-1-lite',
    temperature: 0.2,
    // Generous next to a ~6-token label: thinking models spend budget on
    // reasoning deltas first, and a `length` cutoff would truncate the label.
    max_tokens: 256,
    messages: [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: `Goal: ${goal}` },
    ],
    dump_context: { call_site: 'agent_title' },
  });

  let text = '';
  for await (const chunk of stream) {
    text += chunk.choices[0]?.delta?.content ?? '';
  }
  return text;
}
/* c8 ignore stop */

/**
 * Generate and persist a short title for an agent. Fire-and-forget: callers do
 * NOT await this, and it never throws.
 *
 * Skips sub-agents (they don't appear in the sidebar) and any agent that
 * already has a title (a rename that beat the generator must win).
 */
export async function generateAgentTitle(agentId: string): Promise<void> {
  try {
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { goal: true, title: true, parentAgentId: true },
    });

    if (!agent) {
      log.warn('Agent not found, skipping title generation', { agent_id: agentId });
      return;
    }
    if (agent.parentAgentId !== null) return;
    if (agent.title !== null && agent.title !== '') return;

    // Throwing (rather than returning null) on an empty label is what makes an
    // empty/reasoning-only stream retryable — returning null would silently
    // burn the one attempt and leave the agent untitled.
    const title = await retryWithBackoff(
      async () => {
        const normalized = normalizeTitle(await requestTitle(agent.goal));
        if (normalized === null) throw new EmptyTitleError();
        return normalized;
      },
      { maxRetries: 3, isRetryable: isRetryableTitleError, component: 'AgentTitle' }
    );

    // updateMany with a title:null guard so a rename that landed while the LLM
    // was streaming is not clobbered.
    const { count } = await prisma.agent.updateMany({
      where: { id: agentId, title: null },
      data: { title },
    });

    if (count === 0) {
      log.info('Title already set by rename, keeping user value', { agent_id: agentId });
      return;
    }
    log.info('Generated agent title', { agent_id: agentId, title });
  } catch (error) {
    // A missing title is cosmetic — the UI falls back to the goal.
    log.warn('Title generation failed, falling back to goal', {
      agent_id: agentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
