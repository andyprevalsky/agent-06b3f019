/**
 * Internal user-tool routes (mounted on /api/user-ui; agents worker only):
 *
 * POST /tool-calls/claim     claim a side-effecting call   → claimed | done | running | 409 conflict
 * POST /tool-calls/complete  store its run record          → { run } (first write wins) | 404
 * POST /tool-calls/release   handler never started         → { status: 'released' | 'not_started' }
 * POST /tools/run            run in the caller's own code session → { run, code_session_id, ... }
 *
 * Auth: X-API-Key (internal) + X-User-Id; everything is scoped to that user.
 */
import { type NextFunction, type Response, type Router } from 'express';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import * as tools from './service.tools';
import {
  userToolCallClaimSchema,
  userToolCallCompleteSchema,
  userToolCallReleaseSchema,
  userToolRunSchema,
} from './types';

function withHybridAuth(req: HybridAuthRequest, res: Response, next: NextFunction): void {
  void hybridAuth(req, res, next);
}

/** The internal caller's user, or null after sending 403/400. */
function internalUserId(req: HybridAuthRequest, res: Response): string | null {
  if (req.isInternal !== true) {
    res.status(403).json({ error: 'Internal callers only' });
    return null;
  }
  if (typeof req.userId !== 'string' || req.userId.length === 0) {
    res.status(400).json({ error: 'X-User-Id is required' });
    return null;
  }
  return req.userId;
}

function invalidBody(res: Response, issues: { path: (string | number)[]; message: string }[]) {
  res.status(400).json({
    error: 'Invalid body',
    details: issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  });
}

export function registerUserToolRoutes(router: Router): void {
  registerToolCallRecordRoutes(router);
  registerToolRunRoute(router);
}

function registerToolCallRecordRoutes(router: Router): void {
  router.post(
    '/tool-calls/claim',
    withHybridAuth,
    asyncHandler<HybridAuthRequest>(async (req, res) => {
      const userId = internalUserId(req, res);
      if (userId === null) return;
      const parsed = userToolCallClaimSchema.safeParse(req.body);
      if (!parsed.success) {
        invalidBody(res, parsed.error.issues);
        return;
      }
      const claim = await tools.claimToolCall(userId, parsed.data);
      res.status(claim.status === 'conflict' ? 409 : 200).json(claim);
    })
  );

  router.post(
    '/tool-calls/complete',
    withHybridAuth,
    asyncHandler<HybridAuthRequest>(async (req, res) => {
      const userId = internalUserId(req, res);
      if (userId === null) return;
      const parsed = userToolCallCompleteSchema.safeParse(req.body);
      if (!parsed.success) {
        invalidBody(res, parsed.error.issues);
        return;
      }
      const run = await tools.completeToolCall(userId, parsed.data.idempotency_key, {
        ...parsed.data.run,
        code_session_id: parsed.data.run.code_session_id ?? null,
      });
      if (run === null) {
        res.status(404).json({ error: 'No claimed call for this idempotency key' });
        return;
      }
      res.json({ run });
    })
  );

  router.post(
    '/tool-calls/release',
    withHybridAuth,
    asyncHandler<HybridAuthRequest>(async (req, res) => {
      const userId = internalUserId(req, res);
      if (userId === null) return;
      const parsed = userToolCallReleaseSchema.safeParse(req.body);
      if (!parsed.success) {
        invalidBody(res, parsed.error.issues);
        return;
      }
      const released = await tools.releaseToolCall(
        userId,
        parsed.data.idempotency_key,
        parsed.data.error ?? 'handler did not start'
      );
      res.json({ status: released ? 'released' : 'not_started' });
    })
  );
}

function registerToolRunRoute(router: Router): void {
  router.post(
    '/tools/run',
    withHybridAuth,
    asyncHandler<HybridAuthRequest>(async (req, res) => {
      const userId = internalUserId(req, res);
      if (userId === null) return;
      const parsed = userToolRunSchema.safeParse(req.body);
      if (!parsed.success) {
        invalidBody(res, parsed.error.issues);
        return;
      }
      try {
        const result = await tools.runTool(userId, parsed.data);
        res.json({
          run: result.run,
          code_session_id: result.codeSessionId,
          resumed_from: result.resumedFrom,
          replayed: result.replayed,
        });
      } catch (error) {
        if (error instanceof tools.UserToolRunError) {
          res.status(error.status).json({ error: error.message, code: error.code });
          return;
        }
        throw error;
      }
    })
  );
}
