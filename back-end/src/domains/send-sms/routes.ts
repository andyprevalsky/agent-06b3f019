import { Router } from 'express';
import { z } from 'zod';
import { authenticateInternal, type AuthRequest } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service';
import { notifySchema } from './types';

const log = createLogger('SendSMS');

const router = Router();

/**
 * Send SMS via Surge
 * POST /api/send-sms
 * Auth: API Key (internal - called by agent worker)
 */
router.post(
  '/',
  authenticateInternal,
  asyncHandler<AuthRequest>(async (req, res) => {
    const phoneNumber = req.body.phone_number as string | undefined;
    const message = req.body.message as string | undefined;

    if (phoneNumber === undefined || phoneNumber === '') {
      res.status(400).json({ error: 'phone_number is required' });
      return;
    }

    if (message === undefined || message === '') {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    try {
      const result = await service.sendViaSurge(phoneNumber, message);
      res.json(result);
    } catch (error) {
      if (error instanceof service.SurgeNotConfiguredError) {
        res.status(500).json({ error: 'Surge not configured' });
        return;
      }
      if (error instanceof service.SurgeApiError) {
        res.status(error.status).json({
          error: `Surge API error (${String(error.status)})`,
          details: error.details,
        });
        return;
      }
      log.error('Error sending SMS', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to send SMS' });
    }
  })
);

/**
 * Direct SMS send (for welcome, completion - no queue)
 * POST /api/send-sms/direct
 * Auth: API Key (internal - called by agent worker)
 */
router.post(
  '/direct',
  authenticateInternal,
  asyncHandler<AuthRequest>(async (req, res) => {
    const userId = req.body.user_id as string | undefined;
    const message = req.body.message as string | undefined;

    if (userId === undefined || userId === '' || message === undefined || message === '') {
      res.status(400).json({ error: 'user_id and message are required' });
      return;
    }

    try {
      const result = await service.sendDirect(userId, message);
      res.json(result);
    } catch (error) {
      if (error instanceof service.UserHasNoPhoneError) {
        res.status(400).json({ error: 'User has no phone number' });
        return;
      }
      log.error('Error in direct endpoint', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to send SMS' });
    }
  })
);

/**
 * Lifecycle SMS notification endpoint
 * POST /api/send-sms/notify
 * Auth: API Key (internal - called by agent worker)
 */
router.post(
  '/notify',
  authenticateInternal,
  asyncHandler<AuthRequest>(async (req, res) => {
    try {
      const data = notifySchema.parse(req.body);
      const result = await service.dispatchNotification(data);
      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        log.error('SMS Notify validation error', {
          errors: JSON.stringify(error.errors),
        });
        res.status(400).json({ error: 'Invalid request data', details: error.errors });
        return;
      }
      log.error('SMS Notify error', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      res.status(500).json({ error: 'Failed to send notification' });
    }
  })
);

export default router;
