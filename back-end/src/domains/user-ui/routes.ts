/**
 * /api/user-ui — publish/activate/list a user's rose_user_ui versions.
 * /usercontent — serve published files (see config.ts for the origin rule).
 *
 * Auth: normal user JWT or hybrid API key (internal X-User-Id / Rose API key)
 * on every /api/user-ui route; POST /versions additionally accepts a
 * short-lived `ruip.` publish token minted for a code-agent sandbox.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import {
  isUserUiPublishToken,
  verifyUserUiPublishToken,
} from '../../providers/userUi/publishToken';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import { USERCONTENT_CACHE_CONTROL, USERCONTENT_CSP } from './config';
import * as service from './service';
import { publishUserUiVersionSchema, userUiVersionIdSchema } from './types';

const log = createLogger('UserUiRoutes');
const router = Router();

function requestOrigin(req: Request): string {
  return `${req.protocol}://${req.get('host') ?? 'localhost'}`;
}

function requireUserId(req: HybridAuthRequest, res: Response): string | null {
  if (typeof req.userId === 'string' && req.userId.length > 0) return req.userId;
  res.status(400).json({ error: 'X-User-Id (or user_id) is required for API-key calls' });
  return null;
}

function handleError(res: Response, err: unknown): void {
  if (err instanceof service.UserUiError) {
    res
      .status(err.status)
      .json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
    return;
  }
  throw err;
}

/** Publish token OR normal hybrid auth. */
function publishAuth(req: HybridAuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!isUserUiPublishToken(bearer)) {
    void hybridAuth(req, res, next);
    return;
  }
  const check = verifyUserUiPublishToken(bearer);
  if (!check.ok) {
    log.warn('Rejected user UI publish token', { reason: check.reason });
    res.status(401).json({ error: `Invalid publish token (${check.reason})` });
    return;
  }
  req.userId = check.userId;
  req.isInternal = false;
  next();
}

function withHybridAuth(req: HybridAuthRequest, res: Response, next: NextFunction): void {
  void hybridAuth(req, res, next);
}

router.post(
  '/versions',
  publishAuth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = requireUserId(req, res);
    if (userId === null) return;
    const parsed = publishUserUiVersionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid body',
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      return;
    }
    try {
      res.status(201).json(await service.publishVersion(userId, parsed.data));
    } catch (err) {
      handleError(res, err);
    }
  })
);

router.post(
  '/versions/:id/activate',
  withHybridAuth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = requireUserId(req, res);
    if (userId === null) return;
    const id = userUiVersionIdSchema.safeParse(req.params.id);
    if (!id.success) {
      res.status(404).json({ error: 'Version not found' });
      return;
    }
    try {
      res.json(await service.activateVersion(userId, id.data));
    } catch (err) {
      handleError(res, err);
    }
  })
);

router.get(
  '/active',
  withHybridAuth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = requireUserId(req, res);
    if (userId === null) return;
    res.json(await service.getActive(userId, requestOrigin(req)));
  })
);

router.get(
  '/versions',
  withHybridAuth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = requireUserId(req, res);
    if (userId === null) return;
    res.json(await service.listVersions(userId));
  })
);

router.post(
  '/publish-token',
  withHybridAuth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = requireUserId(req, res);
    if (userId === null) return;
    res.status(201).json(service.mintPublishToken(userId));
  })
);

export default router;

/**
 * Public, credential-free file serving. Mounted before CORS and cookies: the
 * content is immutable per (unguessable) version id and is loaded by sandboxed
 * iframes whose origin is `null`.
 */
export const usercontentRouter = Router();

usercontentRouter.get(
  '/:versionId/*',
  asyncHandler(async (req: Request, res: Response) => {
    const versionId = userUiVersionIdSchema.safeParse(req.params.versionId);
    const path = (req.params as Record<string, string>)[0] ?? '';
    const file = versionId.success ? await service.readUsercontent(versionId.data, path) : null;
    res.setHeader('Content-Security-Policy', USERCONTENT_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (!file) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    res.setHeader('Cache-Control', USERCONTENT_CACHE_CONTROL);
    res.setHeader('Content-Type', file.contentType);
    res.status(200).send(file.content);
  })
);
