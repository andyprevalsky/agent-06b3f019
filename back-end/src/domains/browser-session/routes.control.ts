/** Browser ownership handshake routes shared by the frontend and activity. */

import { type Response, type Router } from 'express';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  BrowserControlUnavailableError,
  getBrowserControlState,
  SessionNotFoundError,
  setBrowserControlState,
} from './service';
import { browserControlSchema } from './types';

const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

function externalUserId(req: HybridAuthRequest): string | undefined {
  return req.isInternal === true ? undefined : req.userId;
}

function rejectMissingExternalUser(req: HybridAuthRequest, res: Response): boolean {
  const userId = externalUserId(req);
  if (req.isInternal !== true && (userId === undefined || userId === '')) {
    res.status(401).json({ error: 'Unauthorized' });
    return true;
  }
  return false;
}

export function registerBrowserControlRoutes(router: Router): void {
  router.get(
    '/task/:taskId/control',
    auth,
    asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
      try {
        if (rejectMissingExternalUser(req, res)) return;
        res.json(await getBrowserControlState(req.params.taskId, externalUserId(req)));
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          res.status(404).json({ error: 'Session not found' });
          return;
        }
        throw error;
      }
    })
  );

  router.post(
    '/task/:taskId/control',
    auth,
    asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
      try {
        const { mode } = browserControlSchema.parse(req.body);
        if (mode === 'acknowledge' && req.isInternal !== true) {
          res.status(403).json({ error: 'Forbidden' });
          return;
        }
        if (rejectMissingExternalUser(req, res)) return;
        res.json(await setBrowserControlState(req.params.taskId, mode, externalUserId(req)));
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          res.status(404).json({ error: 'Session not found' });
          return;
        }
        if (error instanceof BrowserControlUnavailableError) {
          res.status(409).json({ error: error.message });
          return;
        }
        throw error;
      }
    })
  );
}
