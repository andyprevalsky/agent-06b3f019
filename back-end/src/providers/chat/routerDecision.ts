import { z } from 'zod';

import { grepArgumentsSchema } from '../grepTool';
import { ChatLlmTransientMissError } from './chatStructuredRetry';
import { extractCompleteTopLevelFields, extractPartialStringField } from './routerJsonStream';

export const RouterDecisionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('direct_answer'),
    reasoning: z.string(),
  }),
  z.object({
    action: z.literal('web_search'),
    reasoning: z.string(),
    /** Run in parallel; each becomes its own web_search tool result. */
    queries: z.array(z.string().trim().min(1)).min(1),
  }),
  z.object({
    action: z.literal('grep'),
    reasoning: z.string(),
    /** One call of the shared grep tool definition, run on the user's own data. */
    grep: grepArgumentsSchema,
  }),
  z.object({
    action: z.literal('start_superintelligence'),
    reasoning: z.string(),
    goal: z.string().min(1),
    mode: z.enum(['plan', 'execute']),
  }),
]);

export type RouterDecision = z.infer<typeof RouterDecisionSchema>;

/**
 * Chat routes each turn, then routes it again after every search round (a
 * batch of web searches or one grep) with its results in context: answer,
 * search again, or escalate. After MAX_CHAT_SEARCH_ROUNDS rounds the Router
 * can only answer or escalate.
 */
export type RouterStage = 'initial' | 'after_search' | 'search_budget_spent';

export const MAX_CHAT_SEARCH_ROUNDS = 3;

const DEADLINE_REASONING = 'Route selected before the provider stream finished.';
const ACTION_SYNTAX_REASONING = 'Route selected from a provider action response.';

/** Some providers return a closed action call despite a strict JSON schema. */
function parseProviderActionSyntax(value: string): RouterDecision | null {
  const match =
    /^start_superintelligence\(\s*goal\s*=\s*("(?:\\.|[^"\\])*")\s*,\s*mode\s*=\s*("(?:\\.|[^"\\])*")\s*\)$/.exec(
      value.trim()
    );
  if (!match) return null;
  try {
    const goal: unknown = JSON.parse(match[1]);
    const mode: unknown = JSON.parse(match[2]);
    if (typeof goal !== 'string' || !goal.trim()) return null;
    if (mode !== 'plan' && mode !== 'execute') return null;
    return {
      action: 'start_superintelligence',
      reasoning: ACTION_SYNTAX_REASONING,
      goal,
      mode,
    };
  } catch {
    return null;
  }
}

/**
 * Provider JSON always includes unused fields as "" or []. Legacy cache rows
 * may omit mode or carry one `query` string instead of `queries`.
 */
function normalizeRouterDecisionInput(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  if (raw.action === 'web_search' && raw.queries === undefined && typeof raw.query === 'string') {
    return { ...raw, queries: [raw.query] };
  }
  if (raw.action !== 'start_superintelligence' || raw.mode !== undefined) return value;
  return { ...raw, mode: 'plan' };
}

function parseRouterDecisionObject(value: unknown): RouterDecision {
  const result = RouterDecisionSchema.safeParse(normalizeRouterDecisionInput(value));
  if (!result.success) {
    throw new Error(
      `Router response failed schema: ${result.error.issues[0]?.message ?? 'invalid'}`
    );
  }
  return result.data;
}

export function parseRouterDecisionJson(json: string): RouterDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const providerAction = parseProviderActionSyntax(json);
    if (providerAction) return providerAction;
    throw new Error(`Failed to parse router response as JSON: ${json.substring(0, 200)}`, {
      cause: error,
    });
  }
  return parseRouterDecisionObject(parsed);
}

/**
 * Recover only decisions whose action-specific fields are already complete.
 * This deliberately never guesses a query, goal, or mode from truncated JSON.
 */
export function parsePartialRouterDecisionJson(json: string): RouterDecision | null {
  const fields = extractCompleteTopLevelFields(json);
  if (!fields) return null;
  const text = (name: string): string | undefined => {
    const value = fields[name];
    return typeof value === 'string' ? value : undefined;
  };
  const action = text('action');
  const reasoning =
    text('reasoning') ?? extractPartialStringField(json, 'reasoning') ?? DEADLINE_REASONING;

  if (action === 'direct_answer') {
    try {
      return parseRouterDecisionObject({ action, reasoning });
    } catch {
      return null;
    }
  }

  if (action === 'web_search') {
    // Only a closed queries array is actionable; never guess from a cut-off list.
    const queries = Array.isArray(fields.queries) ? fields.queries : undefined;
    const query = text('query');
    if (!queries && !query) return null;
    try {
      return parseRouterDecisionObject({
        action,
        reasoning,
        ...(queries ? { queries } : { query }),
      });
    } catch {
      return null;
    }
  }

  if (action === 'grep') {
    // Only a closed grep object is actionable; never run a cut-off argument set.
    const grep = fields.grep;
    if (typeof grep !== 'object' || grep === null || Array.isArray(grep)) return null;
    try {
      return parseRouterDecisionObject({ action, reasoning, grep });
    } catch {
      return null;
    }
  }

  if (action === 'start_superintelligence') {
    const goal = text('goal')?.trim();
    if (!goal) return null;
    try {
      return parseRouterDecisionObject({
        action,
        reasoning,
        goal,
        ...(text('mode') !== undefined ? { mode: text('mode') } : {}),
      });
    } catch {
      return null;
    }
  }

  return null;
}

/** Prefer a complete response before recovering an actionable partial one. */
export function parseRouterDecisionAfterDeadline(
  finalizedJson: string,
  accumulatedJson: string
): RouterDecision | null {
  if (finalizedJson) {
    try {
      return parseRouterDecisionJson(finalizedJson);
    } catch {
      // The deadline can interrupt a response before its structured output closes.
    }
  }
  return parsePartialRouterDecisionJson(accumulatedJson);
}

export interface RouterStructuredText {
  currentText(): string;
  finalText(): string;
}

/**
 * Shape a consumed router stream into a decision.
 *
 * Production 2026-09-30 (agent 6e645c29): Cerebras 429 → OpenRouter failover
 * had not emitted an eligible structured item when the 3s completion deadline
 * fired. The caller invoked `finalText()` (requireExactlyOne) and
 * StructuredOutputCardinalityError killed the brand-new agent.
 *
 * This seam must never throw cardinality. Empty / reasoning-only / deadline
 * streams return `decision: null` so the caller can use the existing
 * "no content" / "completion expired" path — never a parse exception.
 */
export function finalizeRouterDecisionFromStream(params: {
  structuredOutput: RouterStructuredText;
  accumulatedJson: string;
  deadlineExpired: boolean;
}): { decision: RouterDecision | null; fullJson: string } {
  // currentText() never throws cardinality. finalText() is the SMS/chat
  // crash class — keep it off this seam.
  const finalizedJson = params.structuredOutput.currentText();
  const fullJson = finalizedJson || params.accumulatedJson;
  if (params.deadlineExpired) {
    return {
      decision: parseRouterDecisionAfterDeadline(finalizedJson, params.accumulatedJson),
      fullJson,
    };
  }
  if (!fullJson) {
    return { decision: null, fullJson: '' };
  }
  try {
    return { decision: parseRouterDecisionJson(fullJson), fullJson };
  } catch {
    return { decision: parsePartialRouterDecisionJson(fullJson), fullJson };
  }
}

/**
 * Turn a finalized stream into a decision or a typed regenerate miss.
 * Callers must retry this class — never fail the agent on the first miss.
 */
export function requireRouterDecision(params: {
  finalized: { decision: RouterDecision | null; fullJson: string };
  deadlineExpired: boolean;
  stage?: RouterStage;
}): RouterDecision {
  const decision = params.finalized.decision;
  if (
    decision &&
    params.stage === 'search_budget_spent' &&
    (decision.action === 'web_search' || decision.action === 'grep')
  ) {
    // The spent-budget schema has no search action; a provider that ignores it missed.
    throw new ChatLlmTransientMissError(
      'parse',
      `Router chose ${decision.action} after the search budget`
    );
  }
  if (decision) return decision;
  if (params.deadlineExpired) {
    throw new ChatLlmTransientMissError('deadline', 'Chat router completion expired');
  }
  if (!params.finalized.fullJson) {
    throw new ChatLlmTransientMissError('empty', 'Router LLM returned no content');
  }
  throw new ChatLlmTransientMissError(
    'parse',
    `Failed to parse router response as JSON: ${params.finalized.fullJson.substring(0, 200)}`
  );
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
