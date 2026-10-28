import { type NextFunction, type Request, type Response, Router } from 'express';
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
import { verifyProxyTraceParam } from '../../providers/codeAgentFastModeEnv';
import { createLogger } from '../../providers/logger';
import { sharedTraceOrdinalReserver } from '../../providers/traceOrdinalShared';
import { asyncHandler } from '../../utils/asyncHandler';
import { FAST_MODE_ANTHROPIC_UPSTREAM, FAST_MODE_CODEX_UPSTREAM } from './config';
import { verifyDemoCacheWriteCapability } from './accountPolicy';
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

interface ProxyMode {
  readEnabled: boolean;
  writeEnabled: boolean;
}

const READ_ONLY: ProxyMode = { readEnabled: true, writeEnabled: false };

/**
 * Cache mode for one proxy request. The routes are unauthenticated and the
 * sandbox controls its base URL, so writes require a capability the backend
 * signed for this exact trace segment (`record.<sig>` reads and writes,
 * `record-only.<sig>` only writes). Anything else is replay-only.
 */
function proxyMode(traceParam: string, segment: string | undefined): ProxyMode | null {
  const match = /^(record|record-only)(?:\.([0-9a-f]+))?$/.exec(segment ?? '');
  if (match === null) return null;
  const readEnabled = match[1] === 'record';
  const signed = match[2] !== undefined && verifyDemoCacheWriteCapability(traceParam, match[2]);
  if (!signed) {
    anthropicLog.warn('Demo cache proxy write capability rejected', { mode: match[1] });
  }
  return { readEnabled, writeEnabled: signed };
}

function stripProxyMode(
  traceParam: string,
  pathAndQuery: string
): ProxyMode & { pathAndQuery: string } {
  const segment = /^\/([^/?]+)/.exec(pathAndQuery)?.[1];
  const mode = proxyMode(traceParam, segment);
  if (mode === null) return { pathAndQuery, ...READ_ONLY };
  const rest = pathAndQuery.slice(1 + (segment ?? '').length);
  return { pathAndQuery: rest === '' || rest.startsWith('?') ? `/${rest}` : rest, ...mode };
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

/**
 * The proxies take no Authorization of their own (the sandbox CLI only knows its
 * base URL), so the trace segment must carry the capability the backend minted
 * for it. Without this a guessed goal hash reads or writes that trace's cache.
 */
function requireProxyCapability(req: Request, res: Response, next: NextFunction): void {
  const traceSegment = verifyProxyTraceParam(req.params.traceParam ?? '');
  if (traceSegment === null) {
    res.status(403).json({ error: 'Invalid Fast Mode proxy capability' });
    return;
  }
  res.locals.traceSegment = traceSegment;
  next();
}

function verifiedTraceSegment(res: Response): string {
  return res.locals.traceSegment as string;
}

/**
 * Call ordinals come from one Postgres sequence per trace session, so a
 * session's calls landing on different backend instances still record and
 * replay consecutive slots (S25).
 */
export const PROXY_ORDINAL_RESERVER = sharedTraceOrdinalReserver;

export const anthropicProxyRouter = Router();
anthropicProxyRouter.use('/:traceParam', requireProxyCapability);

async function handleAnthropic(req: Request, res: Response, mode: ProxyMode): Promise<void> {
  const trace = parseAnthropicTraceParam(verifiedTraceSegment(res));
  const result = await resolveAnthropic(
    trace.traceHash,
    req.body,
    anthropicHeaders(req),
    {
      cacheGet,
      cacheSet,
      fetchUpstream: fetchAnthropicUpstream,
      reserveOrdinal: PROXY_ORDINAL_RESERVER,
    },
    mode.readEnabled,
    { sessionId: trace.sessionId, writeEnabled: mode.writeEnabled }
  );

  anthropicLog.info(`Anthropic proxy ${result.servedFromCache ? 'HIT' : 'MISS'}`, {
    traceHash: trace.traceHash,
    sessionId: trace.sessionId,
    seq: requestSeq(req.body),
    readEnabled: mode.readEnabled,
    writeEnabled: mode.writeEnabled,
    wrote: result.wrote,
  });

  res.status(result.status);
  res.setHeader('content-type', result.contentType);
  res.setHeader(
    'x-fast-mode-cache',
    result.servedFromCache ? 'hit' : mode.readEnabled ? 'miss' : 'record-only'
  );
  res.end(result.body);
}

anthropicProxyRouter.post(
  '/:traceParam/v1/messages',
  asyncHandler(async (req: Request, res: Response) => handleAnthropic(req, res, READ_ONLY))
);

anthropicProxyRouter.post(
  '/:traceParam/:mode/v1/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const mode = proxyMode(verifiedTraceSegment(res), String(req.params.mode));
    if (mode === null) {
      res.status(404).json({ error: 'Unknown proxy mode' });
      return;
    }
    await handleAnthropic(req, res, mode);
  })
);

export const codexProxyRouter = Router();

codexProxyRouter.use(
  '/:traceParam',
  requireProxyCapability,
  asyncHandler(async (req: Request, res: Response) => {
    const traceParam = req.params.traceParam;
    const traceSegment = verifiedTraceSegment(res);
    const trace = parseCodexTraceParam(traceSegment);
    const resolvedPath = stripProxyMode(traceSegment, pathAfterProxyMount(req, traceParam));
    const pathAndQuery = resolvedPath.pathAndQuery;
    const result = await resolveCodex(
      trace.traceHash,
      req.method,
      pathAndQuery,
      req.body,
      codexHeaders(req),
      {
        cacheGet,
        cacheSet,
        fetchUpstream: fetchCodexUpstream,
        reserveOrdinal: PROXY_ORDINAL_RESERVER,
      },
      resolvedPath.readEnabled,
      { sessionId: trace.sessionId, writeEnabled: resolvedPath.writeEnabled }
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
