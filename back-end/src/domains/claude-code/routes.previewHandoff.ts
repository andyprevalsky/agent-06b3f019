/**
 * One-time preview sign-in routes (Rose-in-Rose, L-APPS2; model and threat
 * model in providers/codePreview/handoff.ts).
 *
 * POST /api/claude-code-session/:taskId/preview/handoff
 *      mint a 60 s single-use code for the caller's own task preview. Dev
 *      accounts only (403 ROSE_DEV_ONLY); a real user session is required, so
 *      API keys, impersonated and preview-handoff sessions get 403
 *      USER_SESSION_REQUIRED; another user's task is 404.
 * POST /api/preview-handoff/redeem { code }
 *      exchange the code for an 8 h preview session. Mounted before the global
 *      CORS middleware with its own CORS limited to preview origins.
 */
import cors from 'cors';
import { Router, type Response } from 'express';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { createLogger } from '../../providers/logger';
import {
  PreviewHandoffError,
  isPreviewOrigin,
  mintPreviewHandoff,
  redeemPreviewHandoff,
} from '../../providers/codePreview/handoff';
import { PREVIEW_HANDOFF_AMR } from '../../providers/sessionTokens';
import { asyncHandler } from '../../utils/asyncHandler';
import { ROSE_DEV_ONLY_BODY, isRoseDevUser } from '../../utils/roseDevAccess';
import { previewHandoffRedeemSchema } from './types';

const log = createLogger('PreviewHandoffRoutes');
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export const USER_SESSION_REQUIRED_BODY = {
  error: 'Signing in a preview needs your own signed-in session',
  code: 'USER_SESSION_REQUIRED',
} as const;

/** The caller's id when it is the account holder's own login session, else null. */
function ownSessionUserId(req: HybridAuthRequest): string | null {
  const user = req.user;
  if (req.isInternal === true || req.isRoseApiKey === true || req.isX402 === true) return null;
  if (user === undefined || user.id === '' || user.impersonatedBy !== undefined) return null;
  if (user.authMethod === PREVIEW_HANDOFF_AMR) return null;
  return user.id;
}

function sendHandoffError(res: Response, error: unknown): boolean {
  if (!(error instanceof PreviewHandoffError)) return false;
  res.status(error.status).json({ error: error.message, code: error.code });
  return true;
}

export function registerPreviewHandoffMintRoute(router: Router): void {
  router.post(
    '/:taskId/preview/handoff',
    auth,
    asyncHandler<HybridAuthRequest>(async (req, res: Response) => {
      const userId = ownSessionUserId(req);
      if (userId === null) {
        res.status(403).json(USER_SESSION_REQUIRED_BODY);
        return;
      }
      if (!isRoseDevUser(userId)) {
        res.status(403).json(ROSE_DEV_ONLY_BODY);
        return;
      }
      try {
        const minted = UUID.test(req.params.taskId)
          ? await mintPreviewHandoff(userId, req.params.taskId)
          : null;
        if (minted === null) {
          res.status(404).json({ error: 'Session not found', code: 'CODE_TASK_NOT_FOUND' });
          return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.status(201).json(minted);
      } catch (error) {
        if (sendHandoffError(res, error)) return;
        throw error;
      }
    })
  );
}

/** Mounted at /api/preview-handoff, before the global CORS middleware. */
const previewHandoffRouter = Router();

previewHandoffRouter.use(
  cors({
    origin: (origin, callback) => callback(null, isPreviewOrigin(origin)),
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    credentials: false,
    maxAge: 600,
  })
);

previewHandoffRouter.post(
  '/redeem',
  asyncHandler(async (req, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = previewHandoffRedeemSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'Invalid body', code: 'INVALID_BODY' });
      return;
    }
    try {
      res.json(await redeemPreviewHandoff(body.data.code, req.get('origin')));
    } catch (error) {
      if (sendHandoffError(res, error)) {
        log.warn('Preview handoff redeem refused', { status: res.statusCode });
        return;
      }
      throw error;
    }
  })
);

export default previewHandoffRouter;
