/**
 * Admin-only: run the boxes.dev Bug Report automation to RCA a Rose agent bug.
 *
 *   POST /:id/report-bug              Report Bug button (admin session or API key)
 *   POST /:id/report-bug/screenshots  Report Bug image upload
 *   POST /:id/report-bug/by-agent     root agent report_bug tool (internal API key; launches only in
 *                                     production, otherwise saves the report)
 *   GET  /:id/report-bug/by-agent     the tree root's report_bug report, for /rca (internal API key)
 */

import { type NextFunction, type RequestHandler, type Response, Router } from 'express';
import { requireInternal } from '../../providers/auth';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { createLogger } from '../../providers/logger';
import { BenchmarkHubUnavailableError } from '../../providers/benchmarkHubErrors';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  assertReportBugAdmin,
  ReportBugForbiddenError,
  ReportBugNotConfiguredError,
  ReportBugNotFoundError,
  ReportBugValidationError,
  reportAgentBug,
  uploadBugReportScreenshot,
} from './bugReportService';
import {
  ReportBugLimitError,
  readAgentSelfBugReport,
  reportAgentBugFromAgent,
} from './agentBugReportService';
import { bugReportScreenshotUpload, MAX_BUG_REPORT_SCREENSHOT_BYTES } from './config';

const log = createLogger('ReportBug');
const router = Router();
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

function sendReportBugError(res: Response, error: unknown, agentId: string, action: string): void {
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
  if (error instanceof ReportBugLimitError) {
    res.status(429).json({ error: error.message });
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
  log.error(`Failed to ${action}`, {
    agent_id: agentId,
    error: error instanceof Error ? error.message : String(error),
  });
  res.status(500).json({ error: `Failed to ${action}` });
}

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
      sendReportBugError(res, error, req.params.id, 'report bug');
    }
  })
);

router.post(
  '/:id/report-bug/by-agent',
  auth,
  requireInternal,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const body =
        req.body !== null && typeof req.body === 'object'
          ? (req.body as { description?: unknown; record_only?: unknown })
          : {};
      const result = await reportAgentBugFromAgent(
        req.userId,
        req.params.id,
        body.description,
        {},
        { recordOnly: body.record_only === true }
      );
      res.status(201).json(result);
    } catch (error) {
      sendReportBugError(res, error, req.params.id, 'file agent bug report');
    }
  })
);

router.get(
  '/:id/report-bug/by-agent',
  auth,
  requireInternal,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      res.json(await readAgentSelfBugReport(req.params.id));
    } catch (error) {
      sendReportBugError(res, error, req.params.id, 'read agent bug report');
    }
  })
);

/**
 * Gate before buffering the body, then let multer read one image. Multer
 * reports an oversized screenshot as LIMIT_FILE_SIZE; answer 413, not 500.
 */
const receiveScreenshot: RequestHandler = (req, res, next: NextFunction) => {
  try {
    assertReportBugAdmin((req as HybridAuthRequest).userId);
  } catch (error) {
    sendReportBugError(res, error, req.params.id, 'upload bug report screenshot');
    return;
  }
  bugReportScreenshotUpload.single('file')(req, res, (error: unknown) => {
    const code =
      error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        error: `Screenshot must be at most ${MAX_BUG_REPORT_SCREENSHOT_BYTES / 1024 / 1024} MB`,
      });
      return;
    }
    next(error);
  });
};

router.post(
  '/:id/report-bug/screenshots',
  auth,
  receiveScreenshot,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const result = await uploadBugReportScreenshot(req.userId, req.params.id, req.file);
      res.status(201).json(result);
    } catch (error) {
      sendReportBugError(res, error, req.params.id, 'upload bug report screenshot');
    }
  })
);

export default router;
