import { type Request, type Response, Router } from 'express';
import {
  FORWARD_REQUEST_HEADERS,
  parseTraceParam as parseAnthropicTraceParam,
  requestSeq,
  resolveAnthropic,
} from '../../providers/anthropicProxyCore';
import {
  isCacheableCodexRequest,
  parseTraceParam as parseCodexTraceParam,
  resolveCodex,
} from '../../providers/codexProxyCore';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import { FAST_MODE_ANTHROPIC_UPSTREAM, FAST_MODE_CODEX_UPSTREAM } from './config';
import { cacheGet, cacheSet } from './service';

const anthropicLog = createLogger('AnthropicProxy');
const codexLog = createLogger('CodexProxy');

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

async function fetchAnthropicUpstream(
  body: unknown,
  headers: Record<string, string>
): Promise<{ status: number; contentType: string; body: string }> {
  const upstream = await fetch(`${FAST_MODE_ANTHROPIC_UPSTREAM}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await upstream.text();
  return {
    status: upstream.status,
    contentType: upstream.headers.get('content-type') ?? 'text/event-stream',
    body: text,
  };
}

function anthropicHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const h of FORWARD_REQUEST_HEADERS) {
    const val = req.headers[h];
    if (typeof val === 'string') headers[h] = val;
  }
  return headers;
}

function codexHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(req.headers)) {
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key)) continue;
    if (rawValue === undefined) continue;
    headers[rawKey] = Array.isArray(rawValue) ? rawValue.join(', ') : rawValue;
  }
  return headers;
}

function pathAfterProxyMount(req: Request, traceParam: string): string {
  const marker = `/codex-proxy/${traceParam}`;
  const idx = req.originalUrl.indexOf(marker);
  if (idx < 0) return req.url || '/';
  const tail = req.originalUrl.slice(idx + marker.length);
  return tail === '' ? '/' : tail;
}

function stripRecordOnlyPrefix(pathAndQuery: string): {
  pathAndQuery: string;
  readEnabled: boolean;
} {
  if (pathAndQuery === '/record-only') {
    return { pathAndQuery: '/', readEnabled: false };
  }
  if (pathAndQuery.startsWith('/record-only/')) {
    return { pathAndQuery: pathAndQuery.slice('/record-only'.length), readEnabled: false };
  }
  return { pathAndQuery, readEnabled: true };
}

async function fetchCodexUpstream(
  method: string,
  pathAndQuery: string,
  body: unknown,
  headers: Record<string, string>
): Promise<{ status: number; contentType: string; body: string }> {
  const upperMethod = method.toUpperCase();
  const upstream = await fetch(`${FAST_MODE_CODEX_UPSTREAM.replace(/\/$/, '')}${pathAndQuery}`, {
    method: upperMethod,
    headers,
    body: upperMethod === 'GET' || upperMethod === 'HEAD' ? undefined : JSON.stringify(body),
  });
  const text = await upstream.text();
  return {
    status: upstream.status,
    contentType: upstream.headers.get('content-type') ?? 'text/event-stream',
    body: text,
  };
}

export const anthropicProxyRouter = Router();

anthropicProxyRouter.post(
  '/:traceParam/v1/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const trace = parseAnthropicTraceParam(req.params.traceParam);
    const result = await resolveAnthropic(
      trace.traceHash,
      req.body,
      anthropicHeaders(req),
      { cacheGet, cacheSet, fetchUpstream: fetchAnthropicUpstream },
      true,
      { sessionId: trace.sessionId }
    );

    anthropicLog.info(`Anthropic proxy ${result.servedFromCache ? 'HIT' : 'MISS'}`, {
      traceHash: trace.traceHash,
      sessionId: trace.sessionId,
      seq: requestSeq(req.body),
      wrote: result.wrote,
    });

    res.status(result.status);
    res.setHeader('content-type', result.contentType);
    res.setHeader('x-fast-mode-cache', result.servedFromCache ? 'hit' : 'miss');
    res.end(result.body);
  })
);

anthropicProxyRouter.post(
  '/:traceParam/record-only/v1/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const trace = parseAnthropicTraceParam(req.params.traceParam);
    const result = await resolveAnthropic(
      trace.traceHash,
      req.body,
      anthropicHeaders(req),
      { cacheGet, cacheSet, fetchUpstream: fetchAnthropicUpstream },
      false,
      { sessionId: trace.sessionId }
    );

    anthropicLog.info('Anthropic proxy RECORD', {
      traceHash: trace.traceHash,
      sessionId: trace.sessionId,
      seq: requestSeq(req.body),
      wrote: result.wrote,
    });

    res.status(result.status);
    res.setHeader('content-type', result.contentType);
    res.setHeader('x-fast-mode-cache', 'record-only');
    res.end(result.body);
  })
);

export const codexProxyRouter = Router();

codexProxyRouter.use(
  '/:traceParam',
  asyncHandler(async (req: Request, res: Response) => {
    const traceParam = req.params.traceParam;
    const trace = parseCodexTraceParam(traceParam);
    const resolvedPath = stripRecordOnlyPrefix(pathAfterProxyMount(req, traceParam));
    const pathAndQuery = resolvedPath.pathAndQuery;
    const result = await resolveCodex(
      trace.traceHash,
      req.method,
      pathAndQuery,
      req.body,
      codexHeaders(req),
      { cacheGet, cacheSet, fetchUpstream: fetchCodexUpstream },
      resolvedPath.readEnabled,
      { sessionId: trace.sessionId }
    );

    const cacheable = isCacheableCodexRequest(req.method, pathAndQuery);
    const cacheStatus = result.servedFromCache
      ? result.cacheHitKind === 'terminal_fallback'
        ? 'TERMINAL_FALLBACK'
        : 'HIT_EXACT'
      : !resolvedPath.readEnabled && cacheable
        ? 'RECORD'
        : cacheable
          ? 'MISS'
          : 'PASS';
    codexLog.info(`Codex proxy ${cacheStatus}`, {
      traceHash: trace.traceHash,
      sessionId: trace.sessionId,
      path: pathAndQuery.split('?', 1)[0],
      cacheable: result.cacheable,
      readEnabled: result.readEnabled,
      ordinal: result.ordinal,
      cacheKey: result.cacheKey,
      cacheHitKind: result.cacheHitKind,
      fallbackSourceOrdinal: result.fallbackSourceOrdinal,
      fallbackSourceCacheKey: result.fallbackSourceCacheKey,
      wrote: result.wrote,
    });

    res.status(result.status);
    res.setHeader('content-type', result.contentType);
    if (cacheable) {
      res.setHeader(
        'x-fast-mode-cache',
        result.servedFromCache ? 'hit' : resolvedPath.readEnabled ? 'miss' : 'record-only'
      );
    }
    res.end(result.body);
  })
);
