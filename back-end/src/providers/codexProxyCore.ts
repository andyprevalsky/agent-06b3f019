import { maybeDumpDemoCacheRequest } from './demoCacheRequestDump';
import { CACHE_KEY_VERSION, worldModelCacheScope } from './demoCacheNormalizeConstants';
import { stripSecrets } from './demoCacheNormalizeCore';

const CACHEABLE_CODEX_RESPONSE_PATH = '/backend-api/codex/responses';
const traceOrdinalCounters = new Map<string, number>();

export interface CachedCodexResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface CodexProxyDeps {
  cacheGet: (key: string) => Promise<{ hit: boolean; value: unknown }>;
  cacheSet: (args: {
    key: string;
    kind: 'codex';
    goalHash: string;
    value: unknown;
  }) => Promise<void>;
  fetchUpstream: (
    method: string,
    pathAndQuery: string,
    body: unknown,
    headers: Record<string, string>
  ) => Promise<{ status: number; contentType: string; body: string }>;
}

export interface CodexProxyResult {
  status: number;
  contentType: string;
  body: string;
  servedFromCache: boolean;
  cacheHitKind: 'exact_slot' | 'terminal_fallback' | null;
  wrote: boolean;
  cacheable: boolean;
  readEnabled: boolean;
  ordinal: number | null;
  cacheKey: string | null;
  fallbackSourceOrdinal: number | null;
  fallbackSourceCacheKey: string | null;
}

export interface TraceReplayContext {
  sessionId?: string;
  ordinal?: number;
  /** False for a replay-only session: a live miss is served but never recorded. */
  writeEnabled?: boolean;
}

export function codeAgentSlotKey(
  kind: 'codex' | 'anthropic',
  traceHash: string,
  ordinal: number
): string {
  return `fastmode:${CACHE_KEY_VERSION}:${worldModelCacheScope()}${kind}:${traceHash}:slot:${ordinal}`;
}

interface TraceOrdinalReservation {
  ordinal: number;
  rollback: () => void;
}

function reserveTraceOrdinal(
  kind: 'codex' | 'anthropic',
  traceHash: string,
  sessionId?: string
): TraceOrdinalReservation {
  const counterKey = `${kind}:${traceHash}:${sessionId ?? 'default'}`;
  const ordinal = traceOrdinalCounters.get(counterKey) ?? 0;
  traceOrdinalCounters.set(counterKey, ordinal + 1);
  return {
    ordinal,
    rollback: () => {
      if (traceOrdinalCounters.get(counterKey) === ordinal + 1) {
        if (ordinal === 0) {
          traceOrdinalCounters.delete(counterKey);
        } else {
          traceOrdinalCounters.set(counterKey, ordinal);
        }
      }
    },
  };
}

export function parseTraceParam(raw: string): { traceHash: string; sessionId?: string } {
  const dot = raw.indexOf('.');
  if (dot < 0) return { traceHash: raw };
  return {
    traceHash: raw.slice(0, dot),
    sessionId: decodeURIComponent(raw.slice(dot + 1)),
  };
}

const PROCESS_SESSION_ID_RE = /Process running with session ID\s+(\d+)/g;
const SESSION_ID_FIELD_RE = /("session_id"\s*:\s*)\d+/;
const CODEX_REPLAY_WRITE_STDIN_YIELD_MS = Number(
  process.env.FAST_MODE_CODEX_REPLAY_WRITE_STDIN_YIELD_MS ?? '30000'
);

export function isCacheableCodexRequest(method: string, pathAndQuery: string): boolean {
  const path = pathAndQuery.split('?', 1)[0];
  return method.toUpperCase() === 'POST' && path === CACHEABLE_CODEX_RESPONSE_PATH;
}

export function canonicalizeCodexResponseRequest(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (record.parallel_tool_calls === false) return body;
  return {
    ...record,
    // Code-agent shell sessions are stateful. Parallel tool calls can race a
    // follow-up inspection against a still-running write_stdin poll, which makes
    // hot replay diverge even though tool execution remains live.
    parallel_tool_calls: false,
  };
}

function collectLiveProcessSessionIds(value: unknown): number[] {
  const ids: number[] = [];

  function visit(v: unknown): void {
    if (typeof v === 'string') {
      for (const match of v.matchAll(PROCESS_SESSION_ID_RE)) {
        const id = Number(match[1]);
        if (Number.isFinite(id)) ids.push(id);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (v !== null && typeof v === 'object') {
      for (const item of Object.values(v as Record<string, unknown>)) visit(item);
    }
  }

  visit(value);
  return ids;
}

function rewriteWriteStdinArguments(argumentsText: string, liveSessionId: number): string | null {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const record = parsed as Record<string, unknown>;
    let changed = false;
    if (record.session_id !== liveSessionId) {
      record.session_id = liveSessionId;
      changed = true;
    }

    // Cached replay runs faster than cold recording, so a short poll can observe
    // a still-running install/process where cold observed completion. Waiting
    // longer preserves live tool execution while stabilizing the next LLM input.
    const isEmptyPoll = record.chars === undefined || record.chars === '';
    if (
      isEmptyPoll &&
      Number.isFinite(CODEX_REPLAY_WRITE_STDIN_YIELD_MS) &&
      CODEX_REPLAY_WRITE_STDIN_YIELD_MS > 0 &&
      (typeof record.yield_time_ms !== 'number' ||
        record.yield_time_ms < CODEX_REPLAY_WRITE_STDIN_YIELD_MS)
    ) {
      record.yield_time_ms = CODEX_REPLAY_WRITE_STDIN_YIELD_MS;
      changed = true;
    }

    return changed ? JSON.stringify(record) : null;
  } catch {
    if (!SESSION_ID_FIELD_RE.test(argumentsText)) return null;
    return argumentsText.replace(
      SESSION_ID_FIELD_RE,
      (_match, prefix: string) => `${prefix}${liveSessionId}`
    );
  }
}

function rewriteCodexResponseData(
  value: unknown,
  liveSessionId: number,
  targetArgumentsByItemId: Map<string, string>
): boolean {
  if (Array.isArray(value)) {
    let changed = false;
    for (const item of value)
      changed = rewriteCodexResponseData(item, liveSessionId, targetArgumentsByItemId) || changed;
    return changed;
  }
  if (value === null || typeof value !== 'object') return false;

  const record = value as Record<string, unknown>;
  let changed = false;

  const itemId =
    typeof record.item_id === 'string'
      ? record.item_id
      : typeof record.id === 'string'
        ? record.id
        : undefined;

  if (
    typeof record.arguments === 'string' &&
    (record.name === 'write_stdin' || record.type === 'response.function_call_arguments.done')
  ) {
    const rewritten = rewriteWriteStdinArguments(record.arguments, liveSessionId);
    if (rewritten !== null && rewritten !== record.arguments) {
      record.arguments = rewritten;
      if (itemId !== undefined) targetArgumentsByItemId.set(itemId, rewritten);
      changed = true;
    }
  }

  for (const raw of Object.values(record)) {
    changed = rewriteCodexResponseData(raw, liveSessionId, targetArgumentsByItemId) || changed;
  }

  return changed;
}

function parseSseDataLine(
  block: string
): { lines: string[]; dataLineIndex: number; data: unknown } | null {
  const lines = block.split('\n');
  const dataLineIndex = lines.findIndex((line) => line.startsWith('data: '));
  if (dataLineIndex < 0) return null;
  try {
    return {
      lines,
      dataLineIndex,
      data: JSON.parse(lines[dataLineIndex].slice('data: '.length)),
    };
  } catch {
    return null;
  }
}

function isTerminalCodexResponse(value: unknown): value is CachedCodexResponse {
  if (value === null || typeof value !== 'object') return false;
  const body = (value as CachedCodexResponse).body;
  if (typeof body !== 'string' || body.length === 0) return false;

  let sawCompleted = false;
  let sawMessage = false;
  let sawFunctionCall = false;

  for (const block of body.split('\n\n')) {
    const parsed = parseSseDataLine(block);
    if (!parsed || parsed.data === null || typeof parsed.data !== 'object') continue;

    const record = parsed.data as Record<string, unknown>;
    if (record.type === 'response.completed') {
      const response = record.response as Record<string, unknown> | undefined;
      sawCompleted = response?.status === 'completed' || sawCompleted;
      continue;
    }

    if (record.type !== 'response.output_item.done') continue;
    const item = record.item as Record<string, unknown> | undefined;
    if (item?.type === 'message' && item.status === 'completed') sawMessage = true;
    if (item?.type === 'function_call') sawFunctionCall = true;
  }

  return sawCompleted && sawMessage && !sawFunctionCall;
}

async function findLatestTerminalCodexSlot(
  deps: CodexProxyDeps,
  traceHash: string,
  beforeOrdinal: number
): Promise<{ value: CachedCodexResponse; ordinal: number; cacheKey: string } | null> {
  const maxLookback = 8;
  const minOrdinal = Math.max(0, beforeOrdinal - maxLookback);

  for (let previous = beforeOrdinal - 1; previous >= minOrdinal; previous -= 1) {
    const previousKey = codeAgentSlotKey('codex', traceHash, previous);
    const cached = await deps.cacheGet(previousKey);
    if (!cached.hit || cached.value === null || cached.value === undefined) continue;
    if (isTerminalCodexResponse(cached.value)) {
      return { value: cached.value, ordinal: previous, cacheKey: previousKey };
    }
  }

  return null;
}

/**
 * Cached Codex responses may contain a tool call like write_stdin(session_id=N).
 * The tool result is not cached, so the hot run has a different live process id.
 * Rewrite only that volatile argument on replay; all other model output is left
 * untouched and tool execution still happens normally.
 */
export function rewriteCachedCodexReplayBody(body: string, requestBody: unknown): string {
  const liveSessionIds = collectLiveProcessSessionIds(requestBody);
  const liveSessionId = liveSessionIds.at(-1);
  if (liveSessionId === undefined || !body.includes('session_id')) return body;

  const trailingSeparator = body.endsWith('\n\n');
  const blocks = body.split('\n\n');
  if (trailingSeparator) blocks.pop();

  const parsedBlocks = blocks.map((block) => {
    const parsed = parseSseDataLine(block);
    return { raw: block, parsed };
  });

  const targetArgumentsByItemId = new Map<string, string>();
  let changed = false;

  for (const block of parsedBlocks) {
    if (!block.parsed) continue;
    changed =
      rewriteCodexResponseData(block.parsed.data, liveSessionId, targetArgumentsByItemId) ||
      changed;
  }

  if (!changed) return body;

  const emittedDeltaByItemId = new Set<string>();
  const rewritten = parsedBlocks.map((block) => {
    if (!block.parsed) return block.raw;

    const data =
      block.parsed.data !== null && typeof block.parsed.data === 'object'
        ? (block.parsed.data as Record<string, unknown>)
        : null;
    const itemId = typeof data?.item_id === 'string' ? data.item_id : undefined;
    const targetArguments = itemId !== undefined ? targetArgumentsByItemId.get(itemId) : undefined;
    if (
      data?.type === 'response.function_call_arguments.delta' &&
      itemId !== undefined &&
      targetArguments !== undefined
    ) {
      data.delta = emittedDeltaByItemId.has(itemId) ? '' : targetArguments;
      emittedDeltaByItemId.add(itemId);
    }

    const lines = [...block.parsed.lines];
    lines[block.parsed.dataLineIndex] = `data: ${JSON.stringify(block.parsed.data)}`;
    return lines.join('\n');
  });

  return `${rewritten.join('\n\n')}${trailingSeparator ? '\n\n' : ''}`;
}

export async function resolveCodex(
  traceHash: string,
  method: string,
  pathAndQuery: string,
  body: unknown,
  headers: Record<string, string>,
  deps: CodexProxyDeps,
  readEnabled = true,
  traceContext: TraceReplayContext = {}
): Promise<CodexProxyResult> {
  const cacheable = isCacheableCodexRequest(method, pathAndQuery);
  const upstreamBody = cacheable ? canonicalizeCodexResponseRequest(body) : body;
  const ordinalReservation =
    cacheable && traceContext.ordinal === undefined
      ? reserveTraceOrdinal('codex', traceHash, traceContext.sessionId)
      : null;
  const ordinal = cacheable ? (traceContext.ordinal ?? ordinalReservation?.ordinal ?? null) : null;
  const key = ordinal !== null ? codeAgentSlotKey('codex', traceHash, ordinal) : null;
  maybeDumpDemoCacheRequest(traceHash, key, upstreamBody);
  let consumedReservedOrdinal = false;

  try {
    if (key !== null && readEnabled) {
      const cached = await deps.cacheGet(key);
      if (cached.hit && cached.value !== null && cached.value !== undefined) {
        const v = cached.value as CachedCodexResponse;
        consumedReservedOrdinal = true;
        return {
          status: v.status,
          contentType: v.contentType || 'text/event-stream',
          body: rewriteCachedCodexReplayBody(v.body, upstreamBody),
          servedFromCache: true,
          cacheHitKind: 'exact_slot',
          wrote: false,
          cacheable,
          readEnabled,
          ordinal,
          cacheKey: key,
          fallbackSourceOrdinal: null,
          fallbackSourceCacheKey: null,
        };
      }
    }

    if (key !== null && readEnabled && ordinal !== null && ordinal > 0) {
      const terminal = await findLatestTerminalCodexSlot(deps, traceHash, ordinal);
      if (terminal !== null) {
        consumedReservedOrdinal = true;
        return {
          status: terminal.value.status,
          contentType: terminal.value.contentType || 'text/event-stream',
          body: rewriteCachedCodexReplayBody(terminal.value.body, upstreamBody),
          servedFromCache: true,
          cacheHitKind: 'terminal_fallback',
          wrote: false,
          cacheable,
          readEnabled,
          ordinal,
          cacheKey: key,
          fallbackSourceOrdinal: terminal.ordinal,
          fallbackSourceCacheKey: terminal.cacheKey,
        };
      }
    }

    const upstream = await deps.fetchUpstream(method, pathAndQuery, upstreamBody, headers);
    let wrote = false;
    if (
      key !== null &&
      traceContext.writeEnabled !== false &&
      upstream.status >= 200 &&
      upstream.status < 300
    ) {
      const value: CachedCodexResponse = stripSecrets({
        status: upstream.status,
        contentType: upstream.contentType,
        body: upstream.body,
      });
      await deps.cacheSet({ key, kind: 'codex', goalHash: traceHash, value });
      wrote = true;
      consumedReservedOrdinal = true;
    }

    return {
      status: upstream.status,
      contentType: upstream.contentType,
      body: upstream.body,
      servedFromCache: false,
      cacheHitKind: null,
      wrote,
      cacheable,
      readEnabled,
      ordinal,
      cacheKey: key,
      fallbackSourceOrdinal: null,
      fallbackSourceCacheKey: null,
    };
  } finally {
    if (!consumedReservedOrdinal) {
      ordinalReservation?.rollback();
    }
  }
}
