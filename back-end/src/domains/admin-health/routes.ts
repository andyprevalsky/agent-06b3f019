import { Router, type Response } from 'express';
import { authenticate, type AuthRequest } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import {
  AdminHealthForbiddenError,
  assertCanViewAdminHealth,
  getAdminHealth,
  parseTimeSlice,
} from './service';
import {
  getWaitlistPeople,
  inviteWaitlistPerson,
  WaitlistInviteEmailError,
  WaitlistInviteIdempotencyKeyError,
  WaitlistInviteInProgressError,
  WaitlistInviteSmsError,
  WaitlistPersonNotFoundError,
} from './service.waitlist';
import { parseWaitlistPagination, WaitlistPaginationError } from './service.waitlist-pagination';

const log = createLogger('AdminHealth');
const router = Router();

router.get(
  '/',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    try {
      await assertCanViewAdminHealth(req.user.id, req.user.phone);
      const timeSlice = parseTimeSlice(req.query.timeSlice);
      const result = await getAdminHealth(timeSlice);
      res.json(result);
    } catch (error) {
      if (error instanceof AdminHealthForbiddenError) {
        res.status(403).json({ error: error.message });
        return;
      }
      log.error('Admin health metrics failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to load admin health metrics' });
    }
  })
);

router.get(
  '/waitlist',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    try {
      await assertCanViewAdminHealth(req.user.id, req.user.phone);
      const pagination = parseWaitlistPagination(req.query.page, req.query.pageSize);
      const result = await getWaitlistPeople(pagination);
      res.json(result);
    } catch (error) {
      if (error instanceof AdminHealthForbiddenError) {
        res.status(403).json({ error: error.message });
        return;
      }
      if (error instanceof WaitlistPaginationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      log.error('Admin waitlist list failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to load waitlist' });
    }
  })
);

router.post(
  '/waitlist/:id/invite',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    try {
      await assertCanViewAdminHealth(req.user.id, req.user.phone);
      const result = await inviteWaitlistPerson(
        req.params.id,
        undefined,
        req.get('Idempotency-Key')
      );
      res.json(result);
    } catch (error) {
      if (error instanceof AdminHealthForbiddenError) {
        res.status(403).json({ error: error.message });
        return;
      }
      if (error instanceof WaitlistPersonNotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error instanceof WaitlistInviteIdempotencyKeyError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof WaitlistInviteInProgressError) {
        res.status(409).json({ error: error.message });
        return;
      }
      if (error instanceof WaitlistInviteSmsError || error instanceof WaitlistInviteEmailError) {
        res.status(502).json({ error: error.message });
        return;
      }
      log.error('Admin waitlist invite failed', {
        waitlistId: req.params.id,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to send waitlist invite' });
    }
  })
);

export default router;
