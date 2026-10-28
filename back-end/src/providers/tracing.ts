/**
 * Hierarchical span tracing for the backend.
 *
 * - Express middleware emits `span.start` / `span.end` per HTTP request.
 * - Trace context (request_id, span_id, agent_id) is stored in AsyncLocalStorage
 *   so Prisma query hooks, Supabase broadcast helpers, and arbitrary downstream
 *   code can attribute their work to the enclosing request without having to
 *   thread ctx through every function signature.
 * - Incoming headers (X-Parent-Span-Id, X-Request-Id, X-Agent-Id) from the
 *   agent worker are honored so the backend span nests under the worker's span
 *   in the latency trace viewer.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { createLogger } from './logger';

const log = createLogger('Tracing');

export type TraceContext = {
  request_id: string;
  span_id: string;
  parent_span_id?: string;
  agent_id?: string;
};

const storage = new AsyncLocalStorage<TraceContext>();

function genId(): string {
  return crypto.randomBytes(6).toString('hex'); // 12 hex chars, matches agent helper
}

export function currentTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

/** Run `fn` inside a child span. Emits span.start/end and binds span_id. */
export async function withSpan<T>(
  name: string,
  metadata: Record<string, unknown>,
  fn: () => Promise<T>
): Promise<T> {
  const parent = currentTraceContext();
  const span_id = genId();
  const ctx: TraceContext = {
    request_id: parent?.request_id ?? genId(),
    span_id,
    parent_span_id: parent?.span_id,
    agent_id: parent?.agent_id,
  };

  const started = Date.now();
  log.info('span.start', {
    span_name: name,
    span_id,
    parent_span_id: ctx.parent_span_id,
    request_id: ctx.request_id,
    agent_id: ctx.agent_id,
    ...metadata,
  });

  try {
    return await storage.run(ctx, fn);
  } finally {
    log.info('span.end', {
      span_name: name,
      span_id,
      parent_span_id: ctx.parent_span_id,
      request_id: ctx.request_id,
      agent_id: ctx.agent_id,
      duration_ms: Date.now() - started,
      ...metadata,
    });
  }
}

/** Express middleware: establish a request span for every incoming HTTP call. */
const UUID_RE =
  /\/api\/(?:agents|tool-usage)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** Paths that carry a credential (Index 01 MCP: `/mcp/<rose-api-key>`) are logged redacted. */
export function redactPathSecrets(path: string): string {
  return path.replace(/^\/mcp\/[^/]+/, '/mcp/:key');
}

export function tracingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const request_id = (
    req.header('X-Request-Id') ||
    req.header('x-request-id') ||
    genId()
  ).toString();
  const parent_span_id = (
    req.header('X-Parent-Span-Id') ||
    req.header('x-parent-span-id') ||
    ''
  ).toString();
  const header_agent_id = (req.header('X-Agent-Id') || req.header('x-agent-id') || '').toString();
  const uuidMatch = req.path.match(UUID_RE);
  const agent_id = header_agent_id || uuidMatch?.[1];
  const path = redactPathSecrets(req.path);

  const span_id = genId();
  const ctx: TraceContext = {
    request_id,
    span_id,
    parent_span_id: parent_span_id || undefined,
    agent_id: agent_id || undefined,
  };

  const started = Date.now();
  log.info('span.start', {
    span_name: 'http.request',
    span_id,
    parent_span_id: ctx.parent_span_id,
    request_id: ctx.request_id,
    agent_id: ctx.agent_id,
    method: req.method,
    path,
  });

  res.setHeader('X-Request-Id', request_id);
  res.setHeader('X-Span-Id', span_id);

  res.on('finish', () => {
    log.info('span.end', {
      span_name: 'http.request',
      span_id,
      parent_span_id: ctx.parent_span_id,
      request_id: ctx.request_id,
      agent_id: ctx.agent_id,
      method: req.method,
      path,
      status: res.statusCode,
      duration_ms: Date.now() - started,
    });
  });

  storage.run(ctx, () => {
    next();
  });
}
