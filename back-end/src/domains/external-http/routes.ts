import { Router, type Response } from 'express';
import { authenticateInternal, type AuthRequest } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import { InvalidExternalHttpRequestError, ExternalHttpRequestFailedError } from './errors';
import { executeExternalHttpRequest } from './service';
import type { ExternalHttpRequestBody } from './types';

const log = createLogger('ExternalHttp');
const router = Router();

router.post(
  '/request',
  authenticateInternal,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const startTime = Date.now();
    try {
      const payload = req.body as ExternalHttpRequestBody;
      const result = await executeExternalHttpRequest(payload);
      log.info('external-http request completed', {
        elapsed_ms: Date.now() - startTime,
        status: result.status,
        ok: result.ok,
        attempts: result.attempts,
      });
      res.json(result);
    } catch (error) {
      const elapsed = Date.now() - startTime;
      if (error instanceof InvalidExternalHttpRequestError) {
        res.status(400).json({ error: 'INVALID_REQUEST', message: error.message });
        return;
      }
      if (error instanceof ExternalHttpRequestFailedError) {
        res.status(502).json({
          error: 'UPSTREAM_REQUEST_FAILED',
          message: error.message,
          status: error.status,
          body: error.responseBody,
        });
        return;
      }
      log.error('external-http request failed', {
        elapsed_ms: elapsed,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: 'EXTERNAL_HTTP_ERROR',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })
);

export default router;
