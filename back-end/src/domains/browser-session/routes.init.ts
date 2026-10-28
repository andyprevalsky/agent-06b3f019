import { SteelProfileAuthMigrationError } from '../../providers/browser/steelProfileAuthMigration';
import { type RequestHandler, type Router } from 'express';
import { type HybridAuthRequest } from '../../providers/hybridAuth';
import { BrowserProviderRateLimitError } from '../../providers/browser';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import { initSession } from './service';
import { initSessionSchema } from './types';

const log = createLogger('BrowserSession');

export function registerBrowserInitRoute(router: Router, auth: RequestHandler): void {
  router.post(
    '/init',
    auth,
    asyncHandler<HybridAuthRequest>(async (req, res) => {
      let sessionId: string | undefined;
      let releaseOnDisconnect: (() => Promise<unknown>) | undefined;
      let disconnected = res.destroyed;
      let release: Promise<unknown> | undefined;
      const releaseDisconnectedSession = () => {
        if (!disconnected || releaseOnDisconnect === undefined) return;
        // Retain this same operation until its exact allocation returns. A
        // failed native close keeps ERROR for terminal-agent reconciliation.
        release ??= releaseOnDisconnect().catch((error) => {
          log.error('Failed to release disconnected browser initialization', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return release;
      };
      res.once('close', () => {
        // close also fires after success. Only an unfinished response lost
        // its caller; never infer interruption from a completed request body.
        if (res.writableFinished) return;
        disconnected = true;
        void releaseDisconnectedSession();
      });
      try {
        const { user_id, agent_id, start_url, task_id } = initSessionSchema.parse(req.body);
        const userId = req.isInternal === true ? user_id : req.userId;
        if (userId === undefined || userId === '') {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }

        const { releaseOnDisconnect: cleanup, ...result } = await initSession(
          userId,
          agent_id,
          start_url,
          task_id
        );
        sessionId = result.session_id;
        // Persistent logical sessions belong to their durable owner after
        // preparation commits. Only transient allocations give a request cleanup.
        releaseOnDisconnect = cleanup;
        disconnected ||= res.destroyed;
        if (disconnected) {
          await releaseDisconnectedSession();
          return;
        }
        res.json({ success: true, ...result });
      } catch (error) {
        if (res.destroyed) return;
        if (error instanceof BrowserProviderRateLimitError) {
          log.warn('Browser provider rate limit hit during session init', {
            provider: error.provider,
          });
          res.status(429).json({
            error: 'browser_provider_rate_limit',
            provider: error.provider,
            message: 'Browser session rate limit exceeded. Retry after delay.',
          });
          return;
        }
        if (error instanceof SteelProfileAuthMigrationError) {
          res.status(409).json({
            error: 'steel_profile_auth_migration_failed',
            auth_realm: error.authRealm,
            message: error.message,
          });
          return;
        }
        log.error('Failed to init browser session', { error: String(error) });
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Failed to initialize browser session',
        });
      }
    })
  );
}
