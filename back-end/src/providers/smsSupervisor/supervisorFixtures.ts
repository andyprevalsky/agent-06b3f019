import { SmsSupervisorResponseSchema } from './schema';
import type { ToolCall } from './supervisorTools';
import type { CompletionMessage } from '../rose';

interface SupervisorFixtureResponse {
  reasoning: string;
  tool_calls: ToolCall[];
}

export interface LoadedSupervisorFixture {
  response: SupervisorFixtureResponse;
  delayMs: number;
}

const fixtureOverrides = new Map<string, string>();
const fixtureCursors = new Map<string, number>();

export const BYPASS_FIXTURE_REAL_LLM = '__bypass_real_llm__';

export function setSupervisorFixtureOverride(userId: string, fixture: string): void {
  fixtureOverrides.set(userId, fixture);
  fixtureCursors.delete(userId);
}

export function clearSupervisorFixtureOverride(userId: string): void {
  fixtureOverrides.delete(userId);
  fixtureCursors.delete(userId);
}

function selectFixture(userId: string, raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  let selected: unknown = parsed;
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) throw new Error('SMS supervisor fixture sequence is empty');
    const cursor = fixtureCursors.get(userId) ?? 0;
    selected = parsed[Math.min(cursor, parsed.length - 1)];
    fixtureCursors.set(userId, cursor + 1);
  }
  if (typeof selected !== 'object' || selected === null) {
    throw new Error('SMS supervisor fixture must be an object or a non-empty object sequence');
  }
  return { ...(selected as Record<string, unknown>) };
}

/** Resolve deterministic single- or multi-round fixtures for blackbox runs. */
export function loadBlackboxSupervisorResponseFixture(
  userId: string,
  messages: CompletionMessage[] = []
): LoadedSupervisorFixture | null {
  if (process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND !== '1') return null;

  const override = fixtureOverrides.get(userId);
  if (override === BYPASS_FIXTURE_REAL_LLM) return null;
  const raw = override ?? process.env.BLACKBOX_SMS_SUPERVISOR_RESPONSE_JSON;
  if (!raw) return null;

  const rawObject = selectFixture(userId, raw);
  validateExpectedToolResults(rawObject, messages);
  const delayMs =
    typeof rawObject.delay_ms === 'number' &&
    Number.isFinite(rawObject.delay_ms) &&
    rawObject.delay_ms >= 0
      ? rawObject.delay_ms
      : 0;
  delete rawObject.delay_ms;

  const parsed = SmsSupervisorResponseSchema.parse(rawObject);
  return {
    response: { reasoning: parsed.reasoning, tool_calls: parsed.tool_calls },
    delayMs,
  };
}

/** Reuse per-key fixture sequences for notification composers without a global fallback. */
export function loadBlackboxFixtureObject(
  key: string,
  messages: readonly CompletionMessage[]
): Record<string, unknown> | null {
  if (process.env.BLACKBOX_TEST_CAPTURE_OUTBOUND !== '1') return null;
  const raw = fixtureOverrides.get(key);
  if (raw === undefined || raw === BYPASS_FIXTURE_REAL_LLM) return null;
  const rawObject = selectFixture(key, raw);
  validateExpectedToolResults(rawObject, messages);
  return rawObject;
}

function validateExpectedToolResults(
  rawObject: Record<string, unknown>,
  messages: readonly CompletionMessage[]
): void {
  const expectedToolResults = rawObject.expected_tool_result_substrings;
  if (expectedToolResults !== undefined) {
    if (
      !Array.isArray(expectedToolResults) ||
      expectedToolResults.some((part) => typeof part !== 'string')
    ) {
      throw new Error('Expected tool result substrings must be an array of strings');
    }
    const toolResults = messages.filter(
      (message) => message.role === 'tool' && typeof message.content === 'string'
    );
    for (const part of expectedToolResults) {
      if (
        !toolResults.some(
          (message) => typeof message.content === 'string' && message.content.includes(part)
        )
      ) {
        throw new Error(`SMS fixture did not receive expected tool feedback: ${String(part)}`);
      }
    }
  }
  delete rawObject.expected_tool_result_substrings;
}
