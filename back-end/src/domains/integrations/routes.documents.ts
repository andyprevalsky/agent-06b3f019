/**
 * Integration document routes - normalized uploads for LLM exports, notes, and vault files.
 */

import { type Response, Router } from 'express';
import { type AuthRequest, authenticateMachineUpload } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service';

const log = createLogger('Integrations');
const router = Router();

function requestUserId(req: AuthRequest): string | undefined {
  return req.isInternal === true ? (req.headers['x-user-id'] as string | undefined) : req.user?.id;
}

/** POST /api/integrations/documents/upload */
router.post(
  '/documents/upload',
  authenticateMachineUpload,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = requestUserId(req);
    if (userId === undefined || userId === null || userId === '') {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    try {
      const result = await service.processDocumentsUpload(userId, req.body);
      return res.json({
        integration: {
          id: result.integration.id,
          name: result.integration.name,
          status: result.integration.status,
        },
        documents: result.documents,
        documentCount: result.documentCount,
        snapshotRevision: result.snapshotRevision,
        syncState: result.syncState,
        dryRun: result.dryRun,
      });
    } catch (error) {
      log.warn('Document upload failed', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(400).json({
        error: 'DOCUMENT_UPLOAD_FAILED',
        message: error instanceof Error ? error.message : 'Invalid document upload',
      });
    }
  })
);

export default router;
