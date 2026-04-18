/**
 * Hierarchical span tracing provider for the research (Supabase edge function)
 * layer.
 *
 * Lives in providers/ because every public function has a side effect — it
 * writes `span.start` / `span.end` JSON events to stdout via `console.log`.
 *
 * Mirrors `back-end/src/providers/tracing.ts` and `agents/helpers/tracing.py`:
 *   - Emits `span.start` / `span.end` JSON log events with `span_id` and
 *     `parent_span_id` so `agents/benchmarks/agent_latency.py` can stitch them
 *     into the cross-service trace tree.
 *   - Honors `X-Parent-Span-Id`, `X-Request-Id`, `X-Agent-Id`, `X-Call-Site`
 *     incoming headers so each request nests under the agent/backend caller.
 *   - Uses `node:async_hooks` `AsyncLocalStorage` (supported by Deno) so span
 *     context propagates through async work without threading ctx manually.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type TraceContext = {
  request_id: string;
  span_id: string;
  parent_span_id?: string;
  agent_id?: string;
  call_site?: string;
};

const storage = new AsyncLocalStorage<TraceContext>();

function genId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function emit(
  event: 'span.start' | 'span.end',
  fields: Record<string, unknown>,
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level: 'info',
    component: 'Rose',
    message: event,
    ...fields,
  };
  // deno-lint-ignore no-console
  console.log(JSON.stringify(entry));
}

export function currentTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

export function currentSpanId(): string | undefined {
  return storage.getStore()?.span_id;
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.request_id;
}

export function currentAgentId(): string | undefined {
  return storage.getStore()?.agent_id;
}

/** Run `fn` inside a child span. Emits span.start/end and binds span_id for descendants. */
export async function withSpan<T>(
  name: string,
  metadata: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = currentTraceContext();
  const span_id = genId();
  const ctx: TraceContext = {
    request_id: parent?.request_id ?? genId(),
    span_id,
    parent_span_id: parent?.span_id,
    agent_id: parent?.agent_id,
    call_site: parent?.call_site,
  };

  const started = Date.now();
  emit('span.start', {
    span_name: name,
    span_id,
    parent_span_id: ctx.parent_span_id,
    request_id: ctx.request_id,
    agent_id: ctx.agent_id,
    call_site: ctx.call_site,
    ...metadata,
  });

  let status = 'ok';
  try {
    return await storage.run(ctx, fn);
  } catch (e) {
    status = 'error';
    throw e;
  } finally {
    emit('span.end', {
      span_name: name,
      span_id,
      parent_span_id: ctx.parent_span_id,
      request_id: ctx.request_id,
      agent_id: ctx.agent_id,
      call_site: ctx.call_site,
      duration_ms: Date.now() - started,
      status,
      ...metadata,
    });
  }
}

/**
 * Wrap an HTTP handler so every incoming request opens a root span seeded from
 * `X-Parent-Span-Id` / `X-Request-Id` / `X-Agent-Id` / `X-Call-Site` headers.
 * The inner handler sees the trace context via `currentTraceContext()`.
 */
export function withRequestSpan(
  name: string,
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const request_id = req.headers.get('x-request-id') || req.headers.get('X-Request-Id') ||
      genId();
    const parent_span_id = req.headers.get('x-parent-span-id') ||
      req.headers.get('X-Parent-Span-Id') ||
      undefined;
    const agent_id = req.headers.get('x-agent-id') || req.headers.get('X-Agent-Id') || undefined;
    const call_site = req.headers.get('x-call-site') || req.headers.get('X-Call-Site') || undefined;

    const span_id = genId();
    const ctx: TraceContext = {
      request_id,
      span_id,
      parent_span_id,
      agent_id,
      call_site,
    };

    const started = Date.now();
    emit('span.start', {
      span_name: name,
      span_id,
      parent_span_id,
      request_id,
      agent_id,
      call_site,
      method: req.method,
      path: url.pathname,
    });

    let status_code = 0;
    let status_label = 'ok';
    try {
      const res = await storage.run(ctx, () => handler(req));
      status_code = res.status;
      if (res.status >= 500) status_label = 'error';

      // Echo trace ids back so callers can correlate without re-parsing logs.
      const headers = new Headers(res.headers);
      if (!headers.has('x-request-id')) headers.set('X-Request-Id', request_id);
      if (!headers.has('x-span-id')) headers.set('X-Span-Id', span_id);
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    } catch (e) {
      status_label = 'error';
      throw e;
    } finally {
      emit('span.end', {
        span_name: name,
        span_id,
        parent_span_id,
        request_id,
        agent_id,
        call_site,
        method: req.method,
        path: url.pathname,
        status_code,
        status: status_label,
        duration_ms: Date.now() - started,
      });
    }
  };
}
