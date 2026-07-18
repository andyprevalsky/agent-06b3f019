import { Router, type Request, type Response } from 'express';
import { authenticate, type AuthRequest } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service';

const log = createLogger('Auth');

const router = Router();

/**
 * POST /api/auth/anonymous
 * Create an anonymous session for users who haven't signed in yet.
 * This allows them to use the service without phone verification.
 */
router.post(
  '/anonymous',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const { user, session } = await service.createAnonymousSession();

      res.json({
        success: true,
        user,
        session,
      });
    } catch (error) {
      log.error('Anonymous session error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to create anonymous session' });
    }
  })
);

/**
 * POST /api/auth/send-otp
 * Send OTP to phone number via Twilio Verify
 */
router.post(
  '/send-otp',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const phone = req.body.phone as string | undefined;

      if (phone === undefined || phone === '') {
        res.status(400).json({ error: 'Phone number is required' });
        return;
      }

      const result = await service.sendOtp(phone);

      if (!result.success) {
        res.status(400).json({ error: result.error ?? 'Failed to send OTP' });
        return;
      }

      res.json({ success: true, message: 'OTP sent' });
    } catch (error) {
      log.error('Send OTP error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to send OTP' });
    }
  })
);

/**
 * POST /api/auth/verify-otp
 * Verify OTP via Twilio Verify, create user record, initialize credit
 */
router.post(
  '/verify-otp',
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const phone = req.body.phone as string | undefined;
      const token = req.body.token as string | undefined;
      const anonymousUserId = req.body.anonymousUserId as string | undefined;
      const firstName = req.body.firstName as string | undefined;
      const lastName = req.body.lastName as string | undefined;
      const email = req.body.email as string | undefined;

      if (phone === undefined || phone === '' || token === undefined || token === '') {
        res.status(400).json({ error: 'Phone and OTP token are required' });
        return;
      }

      const result = await service.verifyOtpAndInitUser({
        phone,
        token,
        anonymousUserId,
        firstName,
        lastName,
        email,
      });

      if (!result.success) {
        res.status(result.statusCode).json({ error: result.error });
        return;
      }

      res.json({
        success: true,
        user: result.user,
        session: result.session,
      });
    } catch (error) {
      log.error('Verify OTP error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to verify OTP' });
    }
  })
);

/**
 * POST /api/auth/complete-onboarding
 * Mark onboarding as complete and send welcome SMS (mac-app flow)
 */
router.post(
  '/complete-onboarding',
  asyncHandler(authenticate),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user?.id;

      if (userId === undefined || userId === '') {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const result = await service.completeOnboarding(userId);

      if (!result.success) {
        res.status(result.statusCode).json({ error: result.error });
        return;
      }

      res.json({
        success: true,
        alreadyCompleted: result.alreadyCompleted,
        onboardingCompletedAt: result.onboardingCompletedAt,
      });
    } catch (error) {
      log.error('Complete onboarding error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to complete onboarding' });
    }
  })
);

export default router;
