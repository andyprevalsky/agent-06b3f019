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
      const result = await plaidService.createPlaidLinkToken(userId);
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
      throw err;
    }
  }),
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

    const institutionRaw = body.institution as Record<string, unknown> | undefined;
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

    try {
      const result = await plaidService.exchangePlaidPublicToken(userId, {
        publicToken,
        institutionId,
        institutionName,
      });
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
      throw err;
    }
  }),
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
  }),
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
      return res.json(result);
    } catch (err) {
      if (err instanceof plaidService.PlaidItemNotFoundError) {
        return res.status(404).json({ error: err.message });
      }
      throw err;
    }
  }),
);

export default router;
