import { CACHE_KEY_VERSION, worldModelCacheScope } from './demoCacheNormalizeConstants';
import { stripSecrets } from './demoCacheNormalizeCore';
import type { ReserveTraceOrdinal } from './traceOrdinal';

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
  /** Shared across instances in production (sharedTraceOrdinalReserver). */
  reserveOrdinal: ReserveTraceOrdinal;
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
  /** False: serve a live miss without recording it. The proxy routes pass false unless the request carries a verified recorder capability. */
  writeEnabled?: boolean;
}

export function anthropicSlotKey(traceHash: string, ordinal: number): string {
  return `fastmode:${CACHE_KEY_VERSION}:${worldModelCacheScope()}anthropic:${traceHash}:slot:${ordinal}`;
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
      ? await deps.reserveOrdinal(`anthropic:${traceHash}:${traceContext.sessionId ?? 'default'}`)
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
    if (traceContext.writeEnabled === false && upstream.status >= 200 && upstream.status < 300) {
      // A replay-only session still used this slot; keep later requests aligned.
      consumedReservedOrdinal = true;
    } else if (upstream.status >= 200 && upstream.status < 300) {
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
      // A failed give-back only leaves a gap in the slot sequence; never let it
      // replace the upstream response the caller is about to receive.
      await ordinalReservation?.rollback().catch(() => undefined);
    }
  }
}
