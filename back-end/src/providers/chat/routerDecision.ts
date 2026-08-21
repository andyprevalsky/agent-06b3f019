import { z } from 'zod';

import { extractCompleteTopLevelStringFields, extractPartialStringField } from './routerJsonStream';

export const RouterDecisionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('direct_answer'),
    reasoning: z.string(),
  }),
  z.object({
    action: z.literal('web_search'),
    reasoning: z.string(),
    query: z.string(),
  }),
  z.object({
    action: z.literal('start_superintelligence'),
    reasoning: z.string(),
    goal: z.string(),
    mode: z.enum(['plan', 'execute']),
  }),
]);

export type RouterDecision = z.infer<typeof RouterDecisionSchema>;

const DEADLINE_REASONING = 'Route selected before the provider stream finished.';

interface RawRouterDecision {
  reasoning?: unknown;
  action?: unknown;
  query?: unknown;
  goal?: unknown;
  mode?: unknown;
}

export function parseRouterDecisionJson(json: string): RouterDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`Failed to parse router response as JSON: ${json.substring(0, 200)}`, {
      cause: error,
    });
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Router response must be a JSON object');
  }
  const raw = parsed as RawRouterDecision;
  if (typeof raw.reasoning !== 'string') {
    throw new Error('Router response requires reasoning');
  }

  switch (raw.action) {
    case 'direct_answer':
      return { action: 'direct_answer', reasoning: raw.reasoning };
    case 'web_search':
      if (typeof raw.query !== 'string' || raw.query === '') {
        throw new Error('web_search action requires a query');
      }
      return { action: 'web_search', reasoning: raw.reasoning, query: raw.query };
    case 'start_superintelligence': {
      if (typeof raw.goal !== 'string' || raw.goal === '') {
        throw new Error('start_superintelligence action requires a goal');
      }
      const mode = raw.mode === undefined ? 'plan' : raw.mode;
      if (mode !== 'plan' && mode !== 'execute') {
        throw new Error('start_superintelligence action requires a valid mode');
      }
      return {
        action: 'start_superintelligence',
        reasoning: raw.reasoning,
        goal: raw.goal,
        mode,
      };
    }
    default:
      throw new Error(`Unknown action: ${String(raw.action)}`);
  }
}

/**
 * Recover only decisions whose action-specific fields are already complete.
 * This deliberately never guesses a query, goal, or mode from truncated JSON.
 */
export function parsePartialRouterDecisionJson(json: string): RouterDecision | null {
  const fields = extractCompleteTopLevelStringFields(json);
  if (!fields) return null;
  const action = fields.action;
  const reasoning =
    fields.reasoning ?? extractPartialStringField(json, 'reasoning') ?? DEADLINE_REASONING;

  if (action === 'direct_answer') return { action, reasoning };

  if (action === 'web_search') {
    const query = fields.query?.trim();
    return query ? { action, reasoning, query } : null;
  }

  if (action === 'start_superintelligence') {
    const goal = fields.goal?.trim();
    const mode = fields.mode;
    if (!goal || (mode !== 'plan' && mode !== 'execute')) return null;
    return { action, reasoning, goal, mode };
  }

  return null;
}

export function isValidRouterCacheJson(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    parseRouterDecisionJson(value);
    return true;
  } catch {
    return false;
  }
}
