/**
 * Integration passkey routes — passkey ingestion from the mac-app.
 * Split from routes.browser.ts for max-lines compliance.
 */

import { type RequestHandler, type Response, Router } from 'express';
// eslint-disable-next-line no-restricted-imports -- Express file upload middleware, configured per-route
import multer from 'multer';
import { type AuthRequest, authenticateMachineUpload } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import { UPLOAD_LIMITS } from './config';
import type { PasskeyPayload } from './types';
import * as service from './service';

const log = createLogger('Integrations');
const router = Router({ mergeParams: true });

const upload = multer({
  dest: '/tmp/integration-uploads/',
  limits: UPLOAD_LIMITS,
});

function hasEncryptedFields(body: Record<string, unknown>): body is {
  data: string;
  iv: string;
  key: string;
  [k: string]: unknown;
} {
  const { data, iv, key } = body;
  return (
    typeof data === 'string' &&
    data !== '' &&
    typeof iv === 'string' &&
    iv !== '' &&
    typeof key === 'string' &&
    key !== ''
  );
}

/** POST /api/integrations/passkeys/upload */
router.post(
  '/passkeys/upload',
  authenticateMachineUpload,
  upload.none() as unknown as RequestHandler,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;

    if (!hasEncryptedFields(req.body)) {
      return res.status(400).json({ error: 'Missing required fields: data, iv, key' });
    }

    const { data, iv, key } = req.body;

    let passkeyData: PasskeyPayload;
    try {
      passkeyData = service.decryptPayload<PasskeyPayload>(data, iv, key);
    } catch (decryptError: unknown) {
      log.error('Passkey decryption failed', {
        error: decryptError instanceof Error ? decryptError.message : String(decryptError),
      });
      return res.status(400).json({ error: 'Failed to decrypt passkey payload' });
    }

    if (!Array.isArray(passkeyData.passkeys)) {
      return res.status(400).json({ error: 'Invalid passkey payload: expected passkeys array' });
    }

    const result = await service.processPasskeysUpload(userId, passkeyData);

    return res.json({
      message: result.passkeyCount > 0 ? 'Passkeys uploaded successfully' : 'No passkeys to upload',
      passkeyCount: result.passkeyCount,
    });
  })
);

export default router;
