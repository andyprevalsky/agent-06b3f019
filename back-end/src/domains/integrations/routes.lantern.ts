import { Router, type Response } from 'express';
import { authenticate, authenticateMachineUpload, type AuthRequest } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service.lantern';

const router = Router();

function userId(req: AuthRequest): string | undefined {
  const id = req.isInternal === true ? req.headers['x-user-id'] : req.user?.id;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
}

async function respond(res: Response, run: () => Promise<unknown>) {
  try {
    return res.json(await run());
  } catch (error) {
    if (error instanceof service.LanternCredentialError)
      return res.status(error.status).json({
        error: error.code,
        code: error.code,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
    return res
      .status(503)
      .json({ error: 'LANTERN_CREDENTIAL_UNAVAILABLE', code: 'LANTERN_CREDENTIAL_UNAVAILABLE' });
  }
}

router.post(
  '/lantern-people/credentials/upload',
  authenticateMachineUpload,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const id = userId(req);
    if (id === undefined)
      return res.status(400).json({ error: 'Missing user ID', code: 'LANTERN_USER_REQUIRED' });
    const body = req.body as { encryptedCredentials?: unknown } | undefined;
    return respond(res, () => service.uploadLanternCredentials(id, body?.encryptedCredentials));
  })
);

router.get(
  '/lantern-people/credentials/token',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.isInternal !== true)
      return res.status(403).json({ error: 'Internal only', code: 'LANTERN_INTERNAL_ONLY' });
    const id = userId(req);
    if (id === undefined)
      return res.status(400).json({ error: 'Missing user ID', code: 'LANTERN_USER_REQUIRED' });
    return respond(res, () => service.getLanternToken(id));
  })
);

export default router;
