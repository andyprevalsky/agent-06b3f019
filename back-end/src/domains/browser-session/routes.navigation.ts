import { type Router } from 'express';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { SessionNotFoundError } from './service.local-storage';
import {
  BrowserNavigationError,
  claimBrowserNavigation,
  completeBrowserNavigation,
  navigateBrowser,
} from './service.navigation';

export function registerBrowserNavigationRoutes(router: Router): void {
  for (const operation of ['navigation', 'navigation/claim', 'navigation/complete'] as const) {
    router.post(
      `/task/:taskId/${operation}`,
      asyncHandler<HybridAuthRequest>(hybridAuth),
      asyncHandler<HybridAuthRequest>(async (req, res) => {
        try {
          const raw: unknown = req.body;
          const body = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<
            string,
            unknown
          >;
          if (req.isInternal !== true && (req.userId === undefined || req.userId === '')) {
            res.status(401).json({ error: 'Unauthorized' });
            return;
          }
          if (operation !== 'navigation' && req.isInternal !== true) {
            res.status(403).json({ error: 'Forbidden' });
            return;
          }
          if (operation === 'navigation') {
            if (body.action !== 'back' && body.action !== 'forward' && body.action !== 'reload') {
              res.status(400).json({ error: 'Invalid navigation action' });
              return;
            }
            res.json(
              await navigateBrowser(
                req.params.taskId,
                body.action,
                req.isInternal === true ? undefined : req.userId
              )
            );
          } else {
            if (typeof body.sessionId !== 'string' || body.sessionId === '') {
              res.status(400).json({ error: 'sessionId is required' });
              return;
            }
            if (operation === 'navigation/claim') {
              res.json({
                command: await claimBrowserNavigation(req.params.taskId, body.sessionId),
              });
            } else {
              if (
                typeof body.id !== 'string' ||
                !(body.url === null || typeof body.url === 'string') ||
                !(body.error === undefined || typeof body.error === 'string')
              ) {
                res.status(400).json({ error: 'Invalid navigation receipt' });
                return;
              }
              await completeBrowserNavigation(req.params.taskId, body.sessionId, body.id, {
                url: body.url,
                ...(body.error !== undefined ? { error: body.error } : {}),
              });
              res.json({ ok: true });
            }
          }
        } catch (error) {
          if (error instanceof SessionNotFoundError) {
            res.status(404).json({ error: 'Session not found' });
            return;
          }
          if (error instanceof BrowserNavigationError) {
            res.status(error.status).json({ error: error.message });
            return;
          }
          throw error;
        }
      })
    );
  }
}
