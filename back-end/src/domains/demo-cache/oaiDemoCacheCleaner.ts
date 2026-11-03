type JsonRecord = Record<string, unknown>;

type ToolCallView = {
  name: string;
  args: JsonRecord | null;
};

export type CacheRewriteResult = {
  value: unknown;
  changed: boolean;
  deleteEntry: boolean;
  browserCallsRemoved: number;
  nestedAgentCallsRemoved: number;
  exploreCallsAdded: number;
};

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function parseArguments(value: unknown): JsonRecord | null {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asRecord(value);
}

function viewToolCall(raw: unknown): ToolCallView | null {
  const call = asRecord(raw);
  if (!call) return null;
  const fn = asRecord(call.function);
  const holder = fn ?? call;
  const name = typeof holder.name === 'string' ? holder.name : '';
  return {
    name,
    args: parseArguments(holder.arguments),
  };
}

function isBrowserCall(view: ToolCallView): boolean {
  return (
    view.name === 'spawn_browser_agent' ||
    (view.name === 'spawn_agent' && view.args?.type === 'browser')
  );
}

function isNestedAgentCall(view: ToolCallView): boolean {
  if (
    view.name === 'spawn_general_purpose_agent' ||
    view.name === 'spawn_general_purpose_agent_for_each' ||
    view.name === 'spawn_code_agent' ||
    view.name === 'spawn_claude_code_agent'
  ) {
    return true;
  }
  return (
    view.name === 'spawn_agent' &&
    (view.args?.type === 'general_purpose' ||
      view.args?.type === 'for_each' ||
      view.args?.type === 'code')
  );
}

function browserFreeNarration(value: unknown): unknown {
  if (typeof value !== 'string' || !/browser|navigat/i.test(value)) return value;
  return value
    .replace(/\bbrowser agents?\b/gi, 'research agent')
    .replace(/\bbrowsers?\b/gi, 'research tools')
    .replace(/\bnavigating\b/gi, 'inspecting')
    .replace(/\bnavigate(?:s|d)?\b/gi, 'inspect');
}

export function containsBrowserToolCall(value: unknown): boolean {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.tool_calls)) return false;
  return record.tool_calls.some((raw) => {
    const view = viewToolCall(raw);
    return view !== null && isBrowserCall(view);
  });
}

export function containsNestedAgentToolCall(value: unknown): boolean {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.tool_calls)) return false;
  return record.tool_calls.some((raw) => {
    const view = viewToolCall(raw);
    return view !== null && isNestedAgentCall(view);
  });
}

/**
 * Remove executable browser and nested-agent work from a cached OAI-demo LLM response.
 *
 * The row is archived instead of rewritten in place. These saved creator
 * trajectories already contain their explore/search evidence; adding new work
 * changes the replay and can miss cache, while leaving the slot would replay a
 * stale spawn decision.
 */
export function rewriteOaiDemoCacheValue(value: unknown): CacheRewriteResult {
  if (!containsBrowserToolCall(value) && !containsNestedAgentToolCall(value)) {
    return {
      value,
      changed: false,
      deleteEntry: false,
      browserCallsRemoved: 0,
      nestedAgentCallsRemoved: 0,
      exploreCallsAdded: 0,
    };
  }

  const rewritten = structuredClone(value) as JsonRecord;
  const rawCalls = Array.isArray(rewritten.tool_calls) ? rewritten.tool_calls : [];
  const nextCalls: unknown[] = [];
  let browserCallsRemoved = 0;
  let nestedAgentCallsRemoved = 0;

  for (const raw of rawCalls) {
    const view = viewToolCall(raw);
    if (!view) {
      nextCalls.push(raw);
      continue;
    }
    if (isBrowserCall(view)) {
      browserCallsRemoved += 1;
      continue;
    }
    if (isNestedAgentCall(view)) {
      nestedAgentCallsRemoved += 1;
      continue;
    }
    nextCalls.push(raw);
  }

  rewritten.tool_calls = nextCalls;
  rewritten.content = browserFreeNarration(rewritten.content);
  rewritten.reasoning = browserFreeNarration(rewritten.reasoning);
  return {
    value: rewritten,
    changed: true,
    deleteEntry: true,
    browserCallsRemoved,
    nestedAgentCallsRemoved,
    exploreCallsAdded: 0,
  };
}
