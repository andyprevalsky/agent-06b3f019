/**
 * Invite-codes routes — thin controller layer.
 *
 * GET  /api/invite-codes/my-code  - Get current user's invite code and usage stats
 * POST /api/invite-codes/use      - Use an invite code during signup
 * GET  /api/invite-codes/check    - Check if user needs to enter an invite code
 */

import { Router, type Response } from 'express';
import { authenticate, type AuthRequest } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  getMyCode,
  useCode,
  checkInviteCode,
  InvalidInviteCodeError,
  AlreadyUsedInviteCodeError,
  InviteCodeNotFoundError,
  InviteCodeExhaustedError,
} from './service';

const router = Router();

/**
 * GET /api/invite-codes/my-code
 * Get the current user's invite code and usage stats
 */
router.get(
  '/my-code',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const result = await getMyCode(req.user.id);
    res.json(result);
  })
);

/**
 * POST /api/invite-codes/use
 * Use an invite code during signup
 * Body: { inviteCode: number }
 */
router.post(
  '/use',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const { inviteCode } = req.body as { inviteCode?: unknown };
      if (typeof inviteCode !== 'number' || !Number.isSafeInteger(inviteCode)) {
        res.status(400).json({ error: 'Valid invite code is required' });
        return;
      }
      const result = await useCode(req.user.id, inviteCode);
      res.json(result);
    } catch (error) {
      if (error instanceof InvalidInviteCodeError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof AlreadyUsedInviteCodeError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof InviteCodeNotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error instanceof InviteCodeExhaustedError) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
  })
);

/**
 * GET /api/invite-codes/check
 * Check if the current user needs to enter an invite code
 * Also creates user record and initializes credit on first call (OTP verification)
 */
router.get(
  '/check',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const result = await checkInviteCode(req.user.id);
    res.json(result);
  })
);

export default router;
