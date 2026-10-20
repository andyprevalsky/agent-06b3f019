/**
 * Sync-progress routes (one account per existing Integration row).
 *
 *   POST   /api/integrations/:provider/accounts/:accountId/progress  write one batch of progress
 *   GET    /api/integrations/progress?since=<cursor>                 the bar poll
 *   DELETE /api/integrations/:provider/accounts/:accountId           alias of DELETE /:name
 *
 * `accountId` is URL-encoded; `default` names the row's legacy `''` key. A
 * non-default id must be an existing row's. Progress writes ingest the caller
 * machine's sync state, so they share the impersonation containment of every
 * other machine-data upload.
 */

import { type Response, Router } from 'express';
import { ZodError } from 'zod';
import { type AuthRequest, authenticate, authenticateMachineUpload } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { findIntegrationAccount } from './repo.accounts';
import * as service from './service';
import * as accounts from './service.accounts';
import { ProgressAccountLimitError, reportIntegrationProgress } from './service.progress';
import {
  assertProviderSlug,
  InvalidAccountKeyError,
  toStorageAccountId,
} from './syncAccountsContract';

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
  } else if (
    error instanceof accounts.IntegrationAccountNotFoundError ||
    error instanceof service.IntegrationNotFoundError
  ) {
    res.status(404).json({ error: error.message });
  } else if (error instanceof accounts.AccountDeleteUnsupportedError) {
    res.status(400).json({ error: 'ACCOUNT_DELETE_UNSUPPORTED', message: error.message });
  } else if (error instanceof service.LanternCredentialError) {
    res.status(error.status).json({ error: error.code });
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
      const { provider } = req.params;
      assertProviderSlug(provider);
      const accountId = toStorageAccountId(req.params.accountId);
      // No new accounts: a non-default id must already be one of this provider's rows.
      if (accountId !== '' && (await findIntegrationAccount(userId, provider, accountId)) === null) {
        throw new accounts.IntegrationAccountNotFoundError(provider, req.params.accountId);
      }
      const outcome = await reportIntegrationProgress({
        userId,
        provider,
        accountId,
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

/** DELETE /api/integrations/:provider/accounts/:accountId (alias of DELETE /:name for `default`) */
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
