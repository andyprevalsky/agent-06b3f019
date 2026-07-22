import { type Response, type Router } from 'express';
import { ZodError } from 'zod';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { BrowserProviderRateLimitError } from '../../providers/browser';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import { getChallengeSolverTelemetry, recoverBrowserChallenge } from './service.challenge-recovery';
import { SessionNotFoundError } from './service.local-storage';
import { recoverChallengeSchema } from './types';

const log = createLogger('BrowserChallengeRecovery');

export function registerBrowserChallengeRecoveryRoutes(router: Router): void {
  router.get(
    '/:taskId/captcha-telemetry',
    authenticate,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      try {
        const result = await getChallengeSolverTelemetry(
          String(req.params.taskId),
          req.isInternal === true ? undefined : req.user?.id
        );
        res.json(result);
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          res.status(404).json({ error: 'Browser task not found' });
          return;
        }
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    })
  );

  router.post(
    '/recover-challenge',
    authenticate,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      try {
        const input = recoverChallengeSchema.parse(req.body);
        const result = await recoverBrowserChallenge({
          taskId: input.task_id,
          userId: req.isInternal === true ? undefined : req.user?.id,
          currentUrl: input.current_url,
          storageState: input.storage_state,
          userAgent: input.user_agent,
        });
        res.json({ success: true, ...result });
      } catch (error) {
        if (error instanceof ZodError) {
          res
            .status(400)
            .json({ error: 'Invalid recover-challenge request', issues: error.issues });
          return;
        }
        if (error instanceof SessionNotFoundError) {
          res.status(404).json({ error: 'Browser task not found' });
          return;
        }
        if (error instanceof BrowserProviderRateLimitError) {
          res.status(429).json({ error: 'browser_provider_rate_limit', provider: error.provider });
          return;
        }
        log.error('Browser challenge recovery failed', { error: String(error) });
        res.status(503).json({
          error: 'browser_challenge_recovery_failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })
  );
}
