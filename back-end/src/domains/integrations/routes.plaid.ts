/**
 * Plaid integration routes.
 *
 *   POST   /api/integrations/plaid/link-token
 *   POST   /api/integrations/plaid/exchange-public-token
 *   GET    /api/integrations/plaid/items
 *   DELETE /api/integrations/plaid/items/:id
 *
 * All endpoints require an authenticated user (Supabase JWT in the
 * Authorization header). The internal-key path (X-User-Id) is also supported,
 * matching the existing Gmail / Compute routes.
 */

import { type Response, Router } from 'express';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import * as plaidService from './service.plaid';
import { clearAccountProgress, clearProviderProgress } from './service.progress';
import {
  handlePlaidWebhook,
  PlaidWebhookVerificationError,
  verifyPlaidWebhook,
  type PlaidWebhookPayload,
} from './service.plaidWebhooks';

const router = Router({ mergeParams: true });

function resolveUserId(req: AuthRequest): string | undefined {
  if (req.isInternal === true) {
    const header = req.headers['x-user-id'];
    return typeof header === 'string' && header.trim() !== '' ? header.trim() : undefined;
  }
  return req.user?.id;
}

router.post(
  '/plaid/link-token',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = resolveUserId(req);
    if (userId === undefined || userId === '') {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    try {
      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const mode = body.mode === 'update' ? 'update' : 'create';
      const itemId = typeof body.itemId === 'string' ? body.itemId : undefined;
      const result =
        mode === 'update' && itemId !== undefined && itemId !== ''
          ? await plaidService.createPlaidUpdateLinkToken(userId, itemId)
          : await plaidService.createPlaidLinkToken(userId);
      return res.json(result);
    } catch (err) {
      if (err instanceof plaidService.PlaidApiError) {
        return res.status(502).json({
          error: 'Plaid API error',
          code: err.errorCode,
          type: err.errorType,
          message: err.message,
        });
      }
      if (err instanceof plaidService.PlaidItemNotFoundError) {
        return res.status(404).json({ error: err.message });
      }
      throw err;
    }
  })
);

router.post(
  '/plaid/exchange-public-token',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = resolveUserId(req);
    if (userId === undefined || userId === '') {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const publicToken = body.public_token ?? body.publicToken;
    if (typeof publicToken !== 'string' || publicToken === '') {
      return res.status(400).json({ error: 'public_token is required' });
    }

    const metadataRaw = body.metadata as Record<string, unknown> | undefined;
    const metadataInstitutionRaw = metadataRaw?.institution as Record<string, unknown> | undefined;
    const institutionRaw =
      (body.institution as Record<string, unknown> | undefined) ?? metadataInstitutionRaw;
    const institutionId =
      typeof body.institution_id === 'string'
        ? body.institution_id
        : typeof institutionRaw?.institution_id === 'string'
          ? institutionRaw.institution_id
          : undefined;
    const institutionName =
      typeof body.institution_name === 'string'
        ? body.institution_name
        : typeof institutionRaw?.name === 'string'
          ? institutionRaw.name
          : undefined;
    const accountsRaw = Array.isArray(body.accounts)
      ? body.accounts
      : Array.isArray(metadataRaw?.accounts)
        ? metadataRaw.accounts
        : [];
    const accounts = accountsRaw
      .filter(
        (account): account is Record<string, unknown> =>
          typeof account === 'object' && account !== null
      )
      .map((account) => ({
        name: typeof account.name === 'string' ? account.name : null,
        mask: typeof account.mask === 'string' ? account.mask : null,
        type: typeof account.type === 'string' ? account.type : null,
        subtype: typeof account.subtype === 'string' ? account.subtype : null,
      }));

    try {
      const result = await plaidService.exchangePlaidPublicToken(userId, {
        publicToken,
        institutionId,
        institutionName,
        accounts,
      });
      return res.json(result);
    } catch (err) {
      if (err instanceof plaidService.PlaidDuplicateItemError) {
        return res.status(409).json({ error: 'DUPLICATE_PLAID_ITEM', message: err.message });
      }
      if (err instanceof plaidService.PlaidApiError) {
        return res.status(502).json({
          error: 'Plaid API error',
          code: err.errorCode,
          type: err.errorType,
          message: err.message,
        });
      }
      throw err;
    }
  })
);

router.post(
  '/plaid/items/:id/update-complete',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = resolveUserId(req);
    if (userId === undefined || userId === '') {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    try {
      const result = await plaidService.completePlaidUpdateMode(userId, req.params.id);
      return res.json(result);
    } catch (err) {
      if (err instanceof plaidService.PlaidItemNotFoundError) {
        return res.status(404).json({ error: err.message });
      }
      throw err;
    }
  })
);

router.get(
  '/plaid/items',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = resolveUserId(req);
    if (userId === undefined || userId === '') {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const items = await plaidService.listPlaidItems(userId);
    return res.json({ items });
  })
);

router.delete(
  '/plaid/items/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = resolveUserId(req);
    if (userId === undefined || userId === '') {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const itemId = req.params.id;
    if (typeof itemId !== 'string' || itemId === '') {
      return res.status(400).json({ error: 'item id is required' });
    }

    try {
      const result = await plaidService.disconnectPlaidItem(userId, itemId);
      await clearAccountProgress(userId, 'plaid', itemId);
      return res.json(result);
    } catch (err) {
      if (err instanceof plaidService.PlaidItemNotFoundError) {
        return res.status(404).json({ error: err.message });
      }
      throw err;
    }
  })
);

router.delete(
  '/plaid',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = resolveUserId(req);
    if (userId === undefined || userId === '') {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    const result = await plaidService.disconnectAllPlaidItems(userId);
    await clearProviderProgress(userId, 'plaid');
    return res.json(result);
  })
);

router.post(
  '/plaid/webhook',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const rawBody =
      (req as AuthRequest & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
    try {
      await verifyPlaidWebhook(rawBody, req.headers['plaid-verification']);
      const result = await handlePlaidWebhook(req.body as PlaidWebhookPayload);
      return res.json(result);
    } catch (err) {
      if (err instanceof PlaidWebhookVerificationError) {
        return res.status(401).json({ error: 'INVALID_PLAID_WEBHOOK', message: err.message });
      }
      throw err;
    }
  })
);

export default router;
