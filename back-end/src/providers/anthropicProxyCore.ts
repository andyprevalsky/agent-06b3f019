import { CACHE_KEY_VERSION, worldModelCacheScope } from './demoCacheNormalizeConstants';
import { stripSecrets } from './demoCacheNormalizeCore';

/** Headers we forward upstream (auth + anthropic protocol headers). */
export const FORWARD_REQUEST_HEADERS = [
  'authorization',
  'x-api-key',
  'anthropic-version',
  'anthropic-beta',
  'content-type',
  'accept',
];

export interface CachedAnthropicResponse {
  status: number;
  contentType: string;
  body: string; // full SSE (or JSON) body
}

export interface ProxyDeps {
  cacheGet: (key: string) => Promise<{ hit: boolean; value: unknown }>;
  cacheSet: (args: {
    key: string;
    kind: 'anthropic';
    goalHash: string;
    value: unknown;
  }) => Promise<void>;
  /** Forward to upstream; returns the full buffered response. */
  fetchUpstream: (
    body: unknown,
    headers: Record<string, string>
  ) => Promise<{ status: number; contentType: string; body: string }>;
}

export function requestSeq(body: unknown): number {
  if (
    body !== null &&
    typeof body === 'object' &&
    Array.isArray((body as { messages?: unknown[] }).messages)
  ) {
    return (body as { messages: unknown[] }).messages.length;
  }
  return 0;
}

export interface ProxyResult {
  status: number;
  contentType: string;
  body: string;
  servedFromCache: boolean;
  wrote: boolean;
}

export interface TraceReplayContext {
  sessionId?: string;
  ordinal?: number;
}

const traceOrdinalCounters = new Map<string, number>();

export function anthropicSlotKey(traceHash: string, ordinal: number): string {
  return `fastmode:${CACHE_KEY_VERSION}:${worldModelCacheScope()}anthropic:${traceHash}:slot:${ordinal}`;
}

interface TraceOrdinalReservation {
  ordinal: number;
  rollback: () => void;
}

function reserveTraceOrdinal(traceHash: string, sessionId?: string): TraceOrdinalReservation {
  const counterKey = `anthropic:${traceHash}:${sessionId ?? 'default'}`;
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

function normalizeAnthropicRequest(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }

  const record = body as Record<string, unknown>;
  const out: Record<string, unknown> = { ...record };

  if (typeof out.model === 'string') {
    // Claude Code adds an internal cache-TTL suffix like "[1m]" when a custom
    // ANTHROPIC_BASE_URL is set. The public Anthropic API does not accept it.
    out.model = out.model.replace(/\[[0-9]+[smhd]\]$/, '');
  }

  return out;
}

/**
 * Core proxy logic — pure given its injected deps. Returns the response to send.
 * On a non-2xx upstream the response is returned but NOT cached (#8: never cache
 * partial/failed responses).
 */
export async function resolveAnthropic(
  traceHash: string,
  body: unknown,
  headers: Record<string, string>,
  deps: ProxyDeps,
  readEnabled = true,
  traceContext: TraceReplayContext = {}
): Promise<ProxyResult> {
  const upstreamBody = normalizeAnthropicRequest(body);
  const ordinalReservation =
    traceContext.ordinal === undefined
      ? reserveTraceOrdinal(traceHash, traceContext.sessionId)
      : null;
  const ordinal = traceContext.ordinal ?? ordinalReservation?.ordinal ?? 0;
  const key = anthropicSlotKey(traceHash, ordinal);
  let consumedReservedOrdinal = false;

  try {
    if (readEnabled) {
      const cached = await deps.cacheGet(key);
      if (cached.hit && cached.value !== null && cached.value !== undefined) {
        const v = cached.value as CachedAnthropicResponse;
        consumedReservedOrdinal = true;
        return {
          status: v.status,
          contentType: v.contentType || 'text/event-stream',
          body: v.body,
          servedFromCache: true,
          wrote: false,
        };
      }
    }

    const upstream = await deps.fetchUpstream(upstreamBody, headers);
    let wrote = false;
    if (upstream.status >= 200 && upstream.status < 300) {
      const value: CachedAnthropicResponse = stripSecrets({
        status: upstream.status,
        contentType: upstream.contentType,
        body: upstream.body,
      });
      await deps.cacheSet({ key, kind: 'anthropic', goalHash: traceHash, value });
      wrote = true;
      consumedReservedOrdinal = true;
    }
    return {
      status: upstream.status,
      contentType: upstream.contentType,
      body: upstream.body,
      servedFromCache: false,
      wrote,
    };
  } finally {
    if (!consumedReservedOrdinal) {
      ordinalReservation?.rollback();
    }
  }
}
