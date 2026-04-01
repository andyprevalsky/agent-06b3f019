/**
 * Integration browser data routes — cookies, localStorage, indexedDB,
 * fingerprint, permissions, cacheStorage, passwords.
 * Split from routes.ts for max-lines compliance.
 */

import { type RequestHandler, type Response, Router } from 'express';
import multer from 'multer';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import { UPLOAD_LIMITS, VALID_BROWSERS } from './config';
import type {
  LocalStoragePayload,
  IndexedDBPayload,
  CacheStoragePayload,
  PermissionPayload,
  PasswordPayload,
} from './types';
import * as service from './service';

const log = createLogger('Integrations');
const router = Router({ mergeParams: true });

const upload = multer({
  dest: '/tmp/integration-uploads/',
  limits: UPLOAD_LIMITS,
});

/** POST /api/integrations/cookies/upload */
router.post(
  '/cookies/upload',
  authenticate,
  upload.none() as unknown as RequestHandler,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { data, iv, key, browser = 'chrome' } = req.body;

    if (!VALID_BROWSERS.includes(browser as string)) {
      return res.status(400).json({
        error: `Invalid browser type: ${browser as string}. Valid types: ${VALID_BROWSERS.join(', ')}`,
      });
    }

    if (
      data === undefined ||
      data === null ||
      data === '' ||
      iv === undefined ||
      iv === null ||
      iv === '' ||
      key === undefined ||
      key === null ||
      key === ''
    ) {
      return res.status(400).json({ error: 'Missing required fields: data, iv, key' });
    }

    let cookies: unknown[];
    try {
      cookies = service.decryptPayload<unknown[]>(data, iv, key);
    } catch (decryptError: unknown) {
      log.error('Cookie decryption failed', {
        error: decryptError instanceof Error ? decryptError.message : String(decryptError),
      });
      return res.status(400).json({ error: 'Failed to decrypt cookie payload' });
    }

    if (!Array.isArray(cookies)) {
      return res.status(400).json({ error: 'Invalid cookie payload: expected array' });
    }

    const result = await service.processCookiesUpload(
      userId,
      cookies as Record<string, unknown>[],
      browser as string
    );

    return res.json({
      message: 'Cookies uploaded successfully',
      cookieCount: result.cookieCount,
      integration: {
        id: result.integration.id,
        name: result.integration.name,
        status: result.integration.status,
      },
    });
  })
);

/** POST /api/integrations/localStorage/upload */
router.post(
  '/localStorage/upload',
  authenticate,
  upload.none() as unknown as RequestHandler,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { data, iv, key, compressed } = req.body;

    if (
      data === undefined ||
      data === null ||
      data === '' ||
      iv === undefined ||
      iv === null ||
      iv === '' ||
      key === undefined ||
      key === null ||
      key === ''
    ) {
      return res.status(400).json({ error: 'Missing required fields: data, iv, key' });
    }

    let localStorageData: LocalStoragePayload;
    try {
      localStorageData = await service.decryptCompressedPayload<LocalStoragePayload>(
        data,
        iv,
        key,
        compressed
      );
    } catch (decryptError: unknown) {
      log.error('localStorage decryption/decompression failed', {
        error: decryptError instanceof Error ? decryptError.message : String(decryptError),
      });
      return res.status(400).json({ error: 'Failed to decrypt localStorage payload' });
    }

    if (
      localStorageData.byOrigin === undefined ||
      localStorageData.byOrigin === null ||
      typeof localStorageData.byOrigin !== 'object'
    ) {
      return res.status(400).json({
        error: 'Invalid localStorage payload: expected byOrigin object',
      });
    }

    const result = await service.processLocalStorageUpload(userId, localStorageData);
    return res.json({ message: 'Batch uploaded', ...result });
  })
);

/** POST /api/integrations/indexedDB/upload */
router.post(
  '/indexedDB/upload',
  authenticate,
  upload.none() as unknown as RequestHandler,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { data, iv, key, compressed } = req.body;

    if (
      data === undefined ||
      data === null ||
      data === '' ||
      iv === undefined ||
      iv === null ||
      iv === '' ||
      key === undefined ||
      key === null ||
      key === ''
    ) {
      return res.status(400).json({ error: 'Missing required fields: data, iv, key' });
    }

    let indexedDBData: IndexedDBPayload;
    try {
      indexedDBData = await service.decryptCompressedPayload<IndexedDBPayload>(
        data,
        iv,
        key,
        compressed
      );
    } catch (decryptError: unknown) {
      log.error('IndexedDB decryption/decompression failed', {
        error: decryptError instanceof Error ? decryptError.message : String(decryptError),
      });
      return res.status(400).json({ error: 'Failed to decrypt IndexedDB payload' });
    }

    if (
      indexedDBData.origins === undefined ||
      indexedDBData.origins === null ||
      !Array.isArray(indexedDBData.origins)
    ) {
      return res.status(400).json({
        error: 'Invalid IndexedDB payload: expected origins array',
      });
    }

    const result = await service.processIndexedDBUpload(userId, indexedDBData);
    return res.json({ message: 'IndexedDB batch uploaded', ...result });
  })
);

/** POST /api/integrations/fingerprint/upload */
router.post(
  '/fingerprint/upload',
  authenticate,
  upload.none() as unknown as RequestHandler,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { data, iv, key } = req.body;

    if (
      data === undefined ||
      data === null ||
      data === '' ||
      iv === undefined ||
      iv === null ||
      iv === '' ||
      key === undefined ||
      key === null ||
      key === ''
    ) {
      return res.status(400).json({ error: 'Missing required fields: data, iv, key' });
    }

    let fingerprint: Record<string, unknown>;
    try {
      fingerprint = service.decryptPayload<Record<string, unknown>>(data, iv, key);
    } catch (decryptError: unknown) {
      log.error('Fingerprint decryption failed', {
        error: decryptError instanceof Error ? decryptError.message : String(decryptError),
      });
      return res.status(400).json({ error: 'Failed to decrypt fingerprint payload' });
    }

    try {
      const integration = await service.processFingerprintUpload(userId, fingerprint);
      return res.json({
        message: 'Fingerprint uploaded successfully',
        integration: {
          id: integration.id,
          name: integration.name,
          status: integration.status,
        },
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('missing required fields')) {
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }
  })
);

/** POST /api/integrations/permissions/upload */
router.post(
  '/permissions/upload',
  authenticate,
  upload.none() as unknown as RequestHandler,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { data, iv, key } = req.body;

    if (
      data === undefined ||
      data === null ||
      data === '' ||
      iv === undefined ||
      iv === null ||
      iv === '' ||
      key === undefined ||
      key === null ||
      key === ''
    ) {
      return res.status(400).json({ error: 'Missing required fields: data, iv, key' });
    }

    let permissionData: PermissionPayload;
    try {
      permissionData = service.decryptPayload<PermissionPayload>(data, iv, key);
    } catch (decryptError: unknown) {
      log.error('Permission decryption failed', {
        error: decryptError instanceof Error ? decryptError.message : String(decryptError),
      });
      return res.status(400).json({ error: 'Failed to decrypt permission payload' });
    }

    if (
      permissionData.grants === undefined ||
      permissionData.grants === null ||
      !Array.isArray(permissionData.grants)
    ) {
      return res.status(400).json({
        error: 'Invalid permission payload: expected grants array',
      });
    }

    const result = await service.processPermissionsUpload(userId, permissionData);
    return res.json({ message: 'Permissions uploaded successfully', ...result });
  })
);

/** POST /api/integrations/cacheStorage/upload */
router.post(
  '/cacheStorage/upload',
  authenticate,
  upload.none() as unknown as RequestHandler,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { data, iv, key, compressed } = req.body;

    if (
      data === undefined ||
      data === null ||
      data === '' ||
      iv === undefined ||
      iv === null ||
      iv === '' ||
      key === undefined ||
      key === null ||
      key === ''
    ) {
      return res.status(400).json({ error: 'Missing required fields: data, iv, key' });
    }

    let cacheStorageData: CacheStoragePayload;
    try {
      cacheStorageData = await service.decryptCompressedPayload<CacheStoragePayload>(
        data,
        iv,
        key,
        compressed
      );
    } catch (decryptError: unknown) {
      log.error('CacheStorage decryption failed', {
        error: decryptError instanceof Error ? decryptError.message : String(decryptError),
      });
      return res.status(400).json({ error: 'Failed to decrypt cacheStorage payload' });
    }

    if (
      cacheStorageData.origins === undefined ||
      cacheStorageData.origins === null ||
      !Array.isArray(cacheStorageData.origins)
    ) {
      return res.status(400).json({
        error: 'Invalid cacheStorage payload: expected origins array',
      });
    }

    const result = await service.processCacheStorageUpload(userId, cacheStorageData);
    return res.json({ message: 'Cache Storage uploaded successfully', ...result });
  })
);

/** POST /api/integrations/passwords/upload */
router.post(
  '/passwords/upload',
  authenticate,
  upload.none() as unknown as RequestHandler,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { data, iv, key } = req.body;

    if (
      data === undefined ||
      data === null ||
      data === '' ||
      iv === undefined ||
      iv === null ||
      iv === '' ||
      key === undefined ||
      key === null ||
      key === ''
    ) {
      return res.status(400).json({ error: 'Missing required fields: data, iv, key' });
    }

    let passwordData: PasswordPayload;
    try {
      passwordData = service.decryptPayload<PasswordPayload>(data, iv, key);
    } catch (decryptError: unknown) {
      log.error('Password decryption failed', {
        error: decryptError instanceof Error ? decryptError.message : String(decryptError),
      });
      return res.status(400).json({ error: 'Failed to decrypt password payload' });
    }

    if (
      passwordData.passwords === undefined ||
      passwordData.passwords === null ||
      !Array.isArray(passwordData.passwords)
    ) {
      return res.status(400).json({
        error: 'Invalid password payload: expected passwords array',
      });
    }

    const result = await service.processPasswordsUpload(userId, passwordData);

    return res.json({
      message:
        result.passwordCount > 0 ? 'Passwords uploaded successfully' : 'No passwords to upload',
      passwordCount: result.passwordCount,
    });
  })
);

export default router;
