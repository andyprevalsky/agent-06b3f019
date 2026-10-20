/**
 * Provider-typed compute token routes.
 */

import { type NextFunction, type Response, Router } from 'express';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import { computeTokenAuthority } from './config';
import * as service from './service';

const router = Router({ mergeParams: true });
const log = createLogger('ComputeTokenAuthority');

// ── Optional shared compute-token authority ────────────────────────────────
//
// Compute-token state (lineage leases, provider cooldowns, funded-key
// cooldowns) is only correct when every consumer of a credential shares ONE
// store. Production has one database. An isolated benchmark guest restores its
// own database and copies the same real credentials into it, so without an
// authority every guest runs its own semaphore and cooldown on one token
// (RCA 2026-10-20-bench-guests-ran-independent-compute-token-semaphores).
// When COMPUTE_TOKEN_AUTHORITY_URL is set, internal compute-code requests are
// answered by that backend instead of the local database. Unset (production),
// this middleware is a no-op.
const FORWARDED_HEADERS = ['x-user-id', 'x-force-pool', 'x-exclude-pool-tokens'] as const;
const AUTHORITY_TIMEOUT_MS = 30_000;

async function delegateToAuthority(
  authority: { url: string; apiKey: string },
  req: AuthRequest,
  res: Response
): Promise<void> {
  const headers: Record<string, string> = { 'X-API-Key': authority.apiKey };
  for (const name of FORWARDED_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  if (hasBody) headers['Content-Type'] = 'application/json';
  const started = Date.now();
  const response = await fetch(`${authority.url}${req.originalUrl}`, {
    method: req.method,
    headers,
    body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
    signal: AbortSignal.timeout(AUTHORITY_TIMEOUT_MS),
  });
  const text = await response.text();
  log.info('Delegated compute-token request', {
    method: req.method,
    path: req.path,
    status: response.status,
    durationMs: Date.now() - started,
  });
  res.status(response.status);
  const contentType = response.headers.get('content-type');
  if (contentType !== null) res.type(contentType);
  res.send(text);
}

router.use('/compute-code', (req: AuthRequest, res: Response, next: NextFunction) => {
  const authority = computeTokenAuthority();
  if (authority === null) return next();
  return authenticate(req, res, () => {
    // User-session requests keep the local view; workers and the runner are internal.
    if (req.isInternal !== true) return next();
    delegateToAuthority(authority, req, res).catch(next);
  });
});

function internalOrAuthUserId(req: AuthRequest): string | undefined {
  const internalHeaderUserId = req.headers['x-user-id'];
  const internalUserId =
    typeof internalHeaderUserId === 'string' && internalHeaderUserId.trim() !== ''
      ? internalHeaderUserId.trim()
      : undefined;
  return req.isInternal === true ? internalUserId : req.user?.id;
}

function excludedPoolIds(req: AuthRequest): string[] | undefined {
  const excludeHeader = req.headers['x-exclude-pool-tokens'] as string | undefined;
  return excludeHeader !== undefined && excludeHeader !== ''
    ? excludeHeader.split(',').map((id) => id.trim())
    : undefined;
}

function queryValue(req: AuthRequest, name: string): string | undefined {
  const value = req.query[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** GET /api/integrations/compute-code/credentials/token */
router.get(
  '/compute-code/credentials/token',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = internalOrAuthUserId(req);
    if (userId === undefined || userId === '') {
      return res.status(400).json({ error: 'Missing user ID' });
    }
    if (Array.isArray(req.query.tokenType)) {
      return res.status(400).json({ error: 'tokenType must be provided at most once' });
    }
    const requestedTokenType = queryValue(req, 'tokenType');
    if (
      requestedTokenType !== undefined &&
      requestedTokenType !== 'claude' &&
      requestedTokenType !== 'gpt'
    ) {
      return res.status(400).json({ error: 'tokenType must be claude or gpt' });
    }

    try {
      const result = await service.getComputeCodeToken(
        userId,
        req.headers['x-force-pool'] === 'true',
        excludedPoolIds(req),
        {
          lineageKey: queryValue(req, 'lineageKey'),
          agentId: queryValue(req, 'agentId'),
          rootAgentId: queryValue(req, 'rootAgentId'),
          fastCacheAffinityKey: queryValue(req, 'fastCacheAffinityKey'),
          tokenType: requestedTokenType,
        }
      );
      return res.json(result);
    } catch (error: unknown) {
      if (error instanceof service.NoTokensAvailableError) {
        return res.status(404).json({ error: error.message });
      }
      throw error;
    }
  })
);

/** POST /api/integrations/compute-code/token/lineage-heartbeat */
router.post(
  '/compute-code/token/lineage-heartbeat',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.isInternal !== true) {
      return res.status(403).json({ error: 'Internal only' });
    }
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const lineageKey = typeof body.lineageKey === 'string' ? body.lineageKey : '';
    return res.json(await service.heartbeatComputeTokenLineage(lineageKey));
  })
);

/** POST /api/integrations/compute-code/token/lineage-release */
router.post(
  '/compute-code/token/lineage-release',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.isInternal !== true) {
      return res.status(403).json({ error: 'Internal only' });
    }
    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const lineageKey = typeof body.lineageKey === 'string' ? body.lineageKey : '';
    return res.json(await service.releaseComputeTokenLineage(lineageKey));
  })
);

/** GET /api/integrations/compute-code/anthropic-key/cooldown
 *  Whether the running backend has the shared ANTHROPIC_API_KEY funded default
 *  and whether it is backed off. Read by agents (which have no DB) so they can
 *  select the same runtime tier without duplicating environment assumptions. */
router.get(
  '/compute-code/anthropic-key/cooldown',
  authenticate,
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    return res.json(await service.getAnthropicApiKeyCooldown());
  })
);

/** Read the shared model/credential-specific Cerebras quota expiry. */
router.get(
  '/compute-code/cerebras-key/cooldown',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.isInternal !== true) return res.status(403).json({ error: 'Internal only' });
    try {
      return res.json(
        await service.getCerebrasApiKeyCooldown(
          String(req.query.credentialId ?? ''),
          String(req.query.model ?? '')
        )
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Invalid Cerebras credential identity or model'
      ) {
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }
  })
);

/** Shared GPT_API_KEY status for agents, which cannot read the backend DB. */
router.get(
  '/compute-code/gpt-key/cooldown',
  authenticate,
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    return res.json(await service.getGptApiKeyCooldown());
  })
);

/** POST /api/integrations/compute-code/token/rate-limited */
router.post(
  '/compute-code/token/rate-limited',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.isInternal !== true) {
      return res.status(403).json({ error: 'Internal only' });
    }

    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const userIdFromHeader = req.headers['x-user-id'] as string | undefined;
    try {
      const result = await service.markComputeTokenRateLimited(
        (body.type as string | undefined) ?? '',
        (body.source as string | undefined) ?? '',
        {
          poolTokenId: body.poolTokenId as string | undefined,
          userId: (body.userId as string | undefined) ?? userIdFromHeader,
          rateLimitedUntil: body.rateLimitedUntil as string | undefined,
          failureReason: body.failureReason as string | undefined,
          credentialId: body.credentialId as string | undefined,
          model: body.model as string | undefined,
        }
      );
      return res.json(result);
    } catch (error: unknown) {
      if (error instanceof Error) {
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }
  })
);

export default router;
