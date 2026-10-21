/**
 * Browser-session IP-rotation route — the rotate_ip tool's backend entry point.
 * Split out of routes.ts to keep that controller under the max-lines budget.
 *
 * POST /api/browser-session/rotate-proxy - Advance the IP/provider recovery ladder
 */

import { respondIfCarriedStateRequired } from './routes.carried-state';
import { carriedStateFromRequest } from './service.carried-state';
import { type Response, type Router } from 'express';
import { ZodError } from 'zod';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import {
  BrowserProviderRateLimitError,
  ProxyRotationUnsupportedError,
} from '../../providers/browser';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  rotateBrowserProxy,
  ProxyRotationExhaustedError,
  RotationSessionNotFoundError,
} from './service';
import { rotateProxySchema } from './types';

const log = createLogger('BrowserSession');

/* c8 ignore start -- rotate-proxy requires the Kernel SDK + a live session */
export function registerBrowserRotationRoute(router: Router): void {
  /**
   * POST /api/browser-session/rotate-proxy
   * rotate_ip tool — swap the browser session's outbound IP to a fresh managed
   * proxy. Advances the per-run Kernel residential → Kernel mobile → Steel
   * ladder and enforces the rotation cap server-side.
   */
  router.post(
    '/rotate-proxy',
    authenticate,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      try {
        const { task_id, current_url, storage_state } = rotateProxySchema.parse(req.body);

        const result = await rotateBrowserProxy(
          task_id,
          req.isInternal === true ? undefined : req.user?.id,
          current_url,
          carriedStateFromRequest(storage_state)
        );

        res.json({ success: true, ...result });
      } catch (error) {
        if (error instanceof ZodError) {
          res.status(400).json({ error: 'Invalid rotate-proxy request', issues: error.issues });
          return;
        }
        if (respondIfCarriedStateRequired(error, res)) return;
        if (error instanceof ProxyRotationExhaustedError) {
          log.warn('Proxy rotation budget exhausted', { cap: error.cap });
          res.status(409).json({
            error: 'proxy_rotation_exhausted',
            cap: error.cap,
            message: error.message,
          });
          return;
        }
        if (error instanceof RotationSessionNotFoundError) {
          res.status(404).json({ error: error.message });
          return;
        }
        if (error instanceof ProxyRotationUnsupportedError) {
          res.status(400).json({ error: error.message, provider: error.provider });
          return;
        }
        if (error instanceof BrowserProviderRateLimitError) {
          log.warn('Browser provider rate limit hit during proxy rotation', {
            provider: error.provider,
          });
          res.status(429).json({
            error: 'browser_provider_rate_limit',
            provider: error.provider,
            message: 'Browser session rate limit exceeded. Retry after delay.',
          });
          return;
        }
        log.error('Failed to rotate browser proxy', { error: String(error) });
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Failed to rotate browser proxy',
        });
      }
    })
  );
}
/* c8 ignore stop */
