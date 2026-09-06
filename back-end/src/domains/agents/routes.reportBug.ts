/** Admin-only: launch a Cursor cloud agent to RCA a Rose agent bug. */

import { Router } from 'express';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { createLogger } from '../../providers/logger';
import { BenchmarkHubUnavailableError } from '../../providers/benchmarkHubErrors';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  ReportBugForbiddenError,
  ReportBugNotConfiguredError,
  ReportBugNotFoundError,
  ReportBugValidationError,
  reportAgentBug,
} from './bugReportService';

const log = createLogger('ReportBug');
const router = Router();
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

router.post(
  '/:id/report-bug',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const description =
        req.body !== null && typeof req.body === 'object' && 'description' in req.body
          ? (req.body as { description: unknown }).description
          : undefined;
      const result = await reportAgentBug(req.userId, req.params.id, description);
      res.status(201).json(result);
    } catch (error) {
      if (error instanceof ReportBugForbiddenError) {
        res.status(403).json({ error: error.message });
        return;
      }
      if (error instanceof ReportBugNotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error instanceof ReportBugValidationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      if (error instanceof ReportBugNotConfiguredError) {
        res.status(503).json({ error: error.message });
        return;
      }
      if (error instanceof BenchmarkHubUnavailableError) {
        res.set('Retry-After', String(error.retryAfterSeconds));
        res.status(503).json({ error: error.message });
        return;
      }
      log.error('Failed to report agent bug', {
        agent_id: req.params.id,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to report bug' });
    }
  })
);

export default router;
