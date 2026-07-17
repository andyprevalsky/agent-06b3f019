import { type Response, Router } from 'express';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service';

const log = createLogger('Integrations');
const router = Router({ mergeParams: true });

/** POST /api/integrations/claude-code/credentials/upload */
router.post(
  '/claude-code/credentials/upload',
  authenticate,
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

    let payload: { encryptedCredentials: string };
    try {
      payload = service.decryptPayload<{ encryptedCredentials: string }>(data, iv, key);
    } catch (decryptError: unknown) {
      log.error('Claude Code credential decryption failed', {
        error: decryptError instanceof Error ? decryptError.message : String(decryptError),
      });
      return res.status(400).json({ error: 'Failed to decrypt credential payload' });
    }

    if (
      payload.encryptedCredentials === undefined ||
      payload.encryptedCredentials === null ||
      payload.encryptedCredentials === ''
    ) {
      return res.status(400).json({ error: 'Invalid payload: missing encryptedCredentials' });
    }

    try {
      await service.uploadClaudeCodeCredentials(userId, payload.encryptedCredentials);
    } catch (error: unknown) {
      if (error instanceof service.CredentialEnvelopeError) {
        return res.status(400).json({ error: `Invalid credential envelope: ${error.message}` });
      }
      throw error;
    }
    return res.json({ message: 'Claude Code credentials uploaded successfully' });
  })
);

/** POST /api/integrations/gpt-code/credentials/upload */
router.post(
  '/gpt-code/credentials/upload',
  authenticate,
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

    let payload: { encryptedCredentials: string };
    try {
      payload = service.decryptPayload<{ encryptedCredentials: string }>(data, iv, key);
    } catch (decryptError: unknown) {
      log.error('GPT Code credential decryption failed', {
        error: decryptError instanceof Error ? decryptError.message : String(decryptError),
      });
      return res.status(400).json({ error: 'Failed to decrypt credential payload' });
    }

    if (
      payload.encryptedCredentials === undefined ||
      payload.encryptedCredentials === null ||
      payload.encryptedCredentials === ''
    ) {
      return res.status(400).json({ error: 'Invalid payload: missing encryptedCredentials' });
    }

    try {
      await service.uploadGptCodeCredentials(userId, payload.encryptedCredentials);
    } catch (error: unknown) {
      if (error instanceof service.CredentialEnvelopeError) {
        return res.status(400).json({ error: `Invalid credential envelope: ${error.message}` });
      }
      throw error;
    }
    return res.json({ message: 'GPT Code credentials uploaded successfully' });
  })
);

/** GET /api/integrations/claude-code/credentials/token */
router.get(
  '/claude-code/credentials/token',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const internalHeaderUserId = req.headers['x-user-id'];
    const internalUserId =
      typeof internalHeaderUserId === 'string' && internalHeaderUserId.trim() !== ''
        ? internalHeaderUserId.trim()
        : undefined;
    const userId = req.isInternal === true ? internalUserId : req.user?.id;

    if (userId === undefined || userId === null || userId === '') {
      return res.status(400).json({ error: 'Missing user ID' });
    }

    const forcePool = req.headers['x-force-pool'] === 'true';
    const excludeHeader = req.headers['x-exclude-pool-tokens'] as string | undefined;
    const excludeIds =
      excludeHeader !== undefined && excludeHeader !== ''
        ? excludeHeader.split(',').map((id) => id.trim())
        : undefined;

    try {
      const result = await service.getClaudeCodeToken(userId, forcePool, excludeIds);
      return res.json(result);
    } catch (error: unknown) {
      if (error instanceof service.ClaudeCodeCredentialsNotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      if (error instanceof service.NoTokensAvailableError) {
        return res.status(404).json({ error: error.message });
      }
      throw error;
    }
  })
);

/** GET /api/integrations/gpt-code/credentials/token */
router.get(
  '/gpt-code/credentials/token',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const internalHeaderUserId = req.headers['x-user-id'];
    const internalUserId =
      typeof internalHeaderUserId === 'string' && internalHeaderUserId.trim() !== ''
        ? internalHeaderUserId.trim()
        : undefined;
    const userId = req.isInternal === true ? internalUserId : req.user?.id;

    if (userId === undefined || userId === null || userId === '') {
      return res.status(400).json({ error: 'Missing user ID' });
    }

    const forcePool = req.headers['x-force-pool'] === 'true';
    const excludeHeader = req.headers['x-exclude-pool-tokens'] as string | undefined;
    const excludeIds =
      excludeHeader !== undefined && excludeHeader !== ''
        ? excludeHeader.split(',').map((id) => id.trim())
        : undefined;

    try {
      const result = await service.getGptCodeToken(userId, forcePool, excludeIds);
      return res.json(result);
    } catch (error: unknown) {
      if (error instanceof service.NoTokensAvailableError) {
        return res.status(404).json({ error: error.message });
      }
      throw error;
    }
  })
);

/** POST /api/integrations/claude-code/token/rate-limited */
router.post(
  '/claude-code/token/rate-limited',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.isInternal !== true) {
      return res.status(403).json({ error: 'Internal only' });
    }

    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const source = body.source as string | undefined;
    const rateLimitedUntil = body.rateLimitedUntil as string | undefined;
    const failureReason = body.failureReason as string | undefined;
    const poolTokenId = body.poolTokenId as string | undefined;
    const userIdFromHeader = req.headers['x-user-id'] as string | undefined;
    const userId = (body.userId as string | undefined) ?? userIdFromHeader;

    try {
      const result = await service.markTokenRateLimited(source ?? '', {
        poolTokenId,
        userId,
        rateLimitedUntil,
        failureReason,
      });
      return res.json(result);
    } catch (error: unknown) {
      if (error instanceof Error) {
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }
  })
);

/** POST /api/integrations/gpt-code/token/rate-limited */
router.post(
  '/gpt-code/token/rate-limited',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.isInternal !== true) {
      return res.status(403).json({ error: 'Internal only' });
    }

    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const source = body.source as string | undefined;
    const rateLimitedUntil = body.rateLimitedUntil as string | undefined;
    const failureReason = body.failureReason as string | undefined;
    const poolTokenId = body.poolTokenId as string | undefined;
    const userIdFromHeader = req.headers['x-user-id'] as string | undefined;
    const userId = (body.userId as string | undefined) ?? userIdFromHeader;

    try {
      const result = await service.markGptTokenRateLimited(source ?? '', {
        poolTokenId,
        userId,
        rateLimitedUntil,
        failureReason,
      });
      return res.json(result);
    } catch (error: unknown) {
      if (error instanceof Error) {
        return res.status(400).json({ error: error.message });
      }
      throw error;
    }
  })
);

/** POST /api/integrations/claude-code/pool-token/rate-limited */
router.post(
  '/claude-code/pool-token/rate-limited',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.isInternal !== true) {
      return res.status(403).json({ error: 'Internal only' });
    }

    const reqBody = (req.body as Record<string, unknown> | undefined) ?? {};
    const poolTokenId = reqBody.poolTokenId as string | undefined;
    const rateLimitedUntil = reqBody.rateLimitedUntil as string | undefined;
    const failureReason = reqBody.failureReason as string | undefined;
    if (poolTokenId === undefined || poolTokenId === null || poolTokenId === '') {
      return res.status(400).json({ error: 'Missing poolTokenId' });
    }

    const result = await service.markPoolTokenAsRateLimited(
      poolTokenId,
      rateLimitedUntil,
      failureReason
    );
    return res.json(result);
  })
);

/** POST /api/integrations/gpt-code/pool-token/rate-limited */
router.post(
  '/gpt-code/pool-token/rate-limited',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.isInternal !== true) {
      return res.status(403).json({ error: 'Internal only' });
    }

    const reqBody = (req.body as Record<string, unknown> | undefined) ?? {};
    const poolTokenId = reqBody.poolTokenId as string | undefined;
    const rateLimitedUntil = reqBody.rateLimitedUntil as string | undefined;
    const failureReason = reqBody.failureReason as string | undefined;
    if (poolTokenId === undefined || poolTokenId === null || poolTokenId === '') {
      return res.status(400).json({ error: 'Missing poolTokenId' });
    }

    const result = await service.markGptPoolTokenAsRateLimited(
      poolTokenId,
      rateLimitedUntil,
      failureReason
    );
    return res.json(result);
  })
);

/** POST /api/integrations/passwords/request */
router.post(
  '/passwords/request',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { request } = req.body;
    const userId = req.user!.id;

    if (typeof request !== 'string' || request.trim().length === 0) {
      return res.status(400).json({ error: 'Request message is required' });
    }

    await service.sendPasswordRequest(userId, request);
    return res.json({ success: true, message: 'Request sent successfully' });
  })
);

export default router;
