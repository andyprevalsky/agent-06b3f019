/** Browser-session reconnect route with internal/external response boundaries. */

import { type Response, type Router } from 'express';
import { BrowserProviderRateLimitError } from '../../providers/browser';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import { resumeBrowserSession, SessionNotFoundError } from './service';
import { resumeSessionSchema } from './types';
import { carriedStateFromRequest, respondIfCarriedStateRequired } from './service.carried-state';

const auth = asyncHandler<HybridAuthRequest>(hybridAuth);
const log = createLogger('BrowserSession');

/* c8 ignore start -- reconnect requires a live browser provider session */
export function registerBrowserResumeRoute(router: Router): void {
  router.post(
    '/resume',
    auth,
    asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
      try {
        const { task_id, force_fresh_profile, storage_state } = resumeSessionSchema.parse(req.body);
        const userId = req.isInternal === true ? undefined : req.userId;
        if (req.isInternal !== true && (userId === undefined || userId === '')) {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }

        const result = await resumeBrowserSession(
          task_id,
          userId,
          force_fresh_profile,
          carriedStateFromRequest(storage_state)
        );
        if (req.isInternal === true) {
          res.json({ success: true, ...result });
        } else {
          res.json({ success: true, task_id: result.task_id, debug_url: result.debug_url });
        }
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          res.status(404).json({ error: 'Session not found' });
          return;
        }
        if (respondIfCarriedStateRequired(error, res)) return;
        if (error instanceof BrowserProviderRateLimitError) {
          log.warn('Browser provider rate limit hit during session resume', {
            provider: error.provider,
          });
          res.status(429).json({
            error: 'browser_provider_rate_limit',
            provider: error.provider,
            message: 'Browser session rate limit exceeded. Retry after delay.',
          });
          return;
        }
        log.error('Failed to resume browser task', { error: String(error) });
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Failed to resume browser task',
        });
      }
    })
  );
}
/* c8 ignore stop */
