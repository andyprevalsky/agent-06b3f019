import { Router, type Response } from 'express';
import { type AuthRequest, authenticateMachineUpload } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  DownloadTelemetryValidationError,
  parseDownloadTelemetry,
  recordDownloadTelemetry,
} from './service';

const log = createLogger('DownloadTelemetry');
const router = Router();

router.post(
  '/',
  authenticateMachineUpload,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    if (req.user === undefined) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    try {
      const payload = parseDownloadTelemetry(req.body);
      await recordDownloadTelemetry(req.user.id, payload);
      res.status(202).json({ accepted: true });
    } catch (error) {
      if (error instanceof DownloadTelemetryValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      log.error('Failed to forward Mac updater download telemetry', {
        user_id: req.user.id,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({ error: 'Download telemetry ingestion failed' });
    }
  })
);

export default router;
