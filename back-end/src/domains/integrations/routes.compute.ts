/**
 * Provider-typed compute token routes.
 */

import { type Response, Router } from 'express';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service';

const router = Router({ mergeParams: true });

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
 *  Whether the shared ANTHROPIC_API_KEY funded default is currently backed off.
 *  Read by the agents Rose client (which has no DB) so it can skip the tier. */
router.get(
  '/compute-code/anthropic-key/cooldown',
  authenticate,
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    return res.json(await service.getAnthropicApiKeyCooldown());
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
