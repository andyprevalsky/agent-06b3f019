/**
 * Per-account integration routes (plan row I0).
 *
 *   POST   /api/integrations/:provider/accounts/:accountId/progress  write one batch of progress
 *   DELETE /api/integrations/:provider/accounts/:accountId           remove ONE account + its data
 *   GET    /api/integrations/progress?since=<cursor>                 cheap chip poll
 *
 * `accountId` is URL-encoded; `default` names the legacy single-account row.
 * Progress writes ingest the caller machine's sync state, so they share the
 * impersonation containment of every other machine-data upload.
 */

import { type Response, Router } from 'express';
import { ZodError } from 'zod';
import { type AuthRequest, authenticate, authenticateMachineUpload } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import * as accounts from './service.accounts';
import { ProgressAccountLimitError, reportIntegrationProgress } from './service.progress';
import { InvalidAccountKeyError } from './syncAccountsContract';

const router = Router();

function resolveUserId(req: AuthRequest): string | undefined {
  if (req.isInternal === true) {
    const header = req.headers['x-user-id'];
    return typeof header === 'string' && header.trim() !== '' ? header.trim() : undefined;
  }
  return req.user?.id;
}

function sendKnownError(error: unknown, res: Response): boolean {
  if (error instanceof ZodError) {
    res.status(400).json({ error: error.errors[0]?.message ?? 'Invalid progress body' });
  } else if (error instanceof InvalidAccountKeyError) {
    res.status(400).json({ error: error.message });
  } else if (error instanceof ProgressAccountLimitError) {
    res.status(409).json({ error: 'ACCOUNT_LIMIT_EXCEEDED', message: error.message });
  } else if (error instanceof accounts.IntegrationAccountNotFoundError) {
    res.status(404).json({ error: error.message });
  } else if (error instanceof accounts.AccountCleanupNotImplementedError) {
    res.status(501).json({
      error: 'ACCOUNT_CLEANUP_NOT_IMPLEMENTED',
      provider: error.provider,
      owner: error.owner,
      reason: error.reason,
    });
  } else {
    return false;
  }
  return true;
}

/** GET /api/integrations/progress?since=<ISO cursor> */
router.get(
  '/progress',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = resolveUserId(req);
    if (userId === undefined || userId === '') {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const raw = req.query.since;
    let since: Date | null = null;
    if (typeof raw === 'string' && raw !== '') {
      since = new Date(raw);
      if (Number.isNaN(since.getTime())) {
        return res.status(400).json({ error: 'since must be an ISO timestamp' });
      }
    }
    return res.json(await accounts.getAccountsDelta(userId, since));
  })
);

/** POST /api/integrations/:provider/accounts/:accountId/progress */
router.post(
  '/:provider/accounts/:accountId/progress',
  authenticateMachineUpload,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = resolveUserId(req);
    if (userId === undefined || userId === '') {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    try {
      const outcome = await reportIntegrationProgress({
        userId,
        provider: req.params.provider,
        accountId: req.params.accountId,
        input: req.body,
      });
      if (outcome.applied) return res.json(outcome);
      if (outcome.reason === 'coalesced') return res.status(202).json(outcome);
      if (outcome.reason === 'stale') return res.status(409).json(outcome);
      return res.json(outcome);
    } catch (error: unknown) {
      if (sendKnownError(error, res)) return undefined;
      throw error;
    }
  })
);

/** DELETE /api/integrations/:provider/accounts/:accountId */
router.delete(
  '/:provider/accounts/:accountId',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = resolveUserId(req);
    if (userId === undefined || userId === '') {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    try {
      const deleted = await accounts.deleteIntegrationAccount(
        userId,
        req.params.provider,
        req.params.accountId
      );
      return res.json({ deleted });
    } catch (error: unknown) {
      if (sendKnownError(error, res)) return undefined;
      throw error;
    }
  })
);

export default router;
