/**
 * LinkedIn export sync routes (plan row I4).
 *
 *   POST /linkedin/sync         {agent_id, account_id?}            record the export agent → starting
 *   POST /linkedin/sync/phase   {agent_id, phase, account_id?,     what only the agent witnesses:
 *                                eta_sec?, error?}                  export_requested | waiting_for_export | failed
 *   POST /linkedin/upload?account_id=<id>   multipart `file` .zip  uploading → parsing → synced | failed
 *
 * The upload counts request bytes as they arrive (before multer stores the
 * file), so `uploading` is reported only while the archive is actually being
 * received. A non-zip file is rejected before any phase is written.
 */

import { type NextFunction, type Request, type Response, Router } from 'express';
import { ZodError } from 'zod';
import { authenticate, authenticateMachineUpload, type AuthRequest } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { linkedinArchiveUpload, removeUploadTempFile } from './config';
import { linkedinPhaseReportSchema } from './linkedinSyncContract';
import * as importer from './service.linkedinImport';
import * as service from './service.linkedinSync';
import { ProgressAccountLimitError } from './service.progress';
import { InvalidAccountKeyError } from './syncAccountsContract';

const router = Router();

function userIdOf(req: AuthRequest): string | null {
  const id = req.isInternal === true ? req.headers['x-user-id'] : req.user?.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

function sendKnownError(error: unknown, res: Response): boolean {
  if (error instanceof ZodError) {
    res.status(400).json({ error: error.errors[0]?.message ?? 'Invalid LinkedIn report' });
  } else if (error instanceof InvalidAccountKeyError) {
    res.status(400).json({ error: error.message });
  } else if (error instanceof importer.LinkedInUploadAccountRequiredError) {
    res
      .status(400)
      .json({ error: 'ACCOUNT_REQUIRED', message: error.message, accounts: error.accounts });
  } else if (
    error instanceof service.LinkedInSyncAgentNotFoundError ||
    error instanceof service.LinkedInSyncNotFoundError
  ) {
    res.status(404).json({ error: error.message });
  } else if (error instanceof service.LinkedInSyncAlreadyRunningError) {
    res.status(409).json({ error: error.message, agent_id: error.agentId });
  } else if (error instanceof service.LinkedInPhaseError) {
    res.status(409).json({ error: error.code, phase: error.current, message: error.message });
  } else if (error instanceof ProgressAccountLimitError) {
    res.status(409).json({ error: 'ACCOUNT_LIMIT_EXCEEDED', message: error.message });
  } else {
    return false;
  }
  return true;
}

/** POST /api/integrations/linkedin/sync — record the spawned export agent. */
router.post(
  '/linkedin/sync',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = userIdOf(req);
    if (userId === null) return res.status(401).json({ error: 'User not authenticated' });
    const body = (req.body ?? {}) as { agent_id?: unknown; account_id?: unknown };
    if (typeof body.agent_id !== 'string' || body.agent_id.trim() === '') {
      return res.status(400).json({ error: 'agent_id is required' });
    }
    if (body.account_id !== undefined && typeof body.account_id !== 'string') {
      return res.status(400).json({ error: 'account_id must be a string' });
    }
    try {
      return res.json(
        await service.startLinkedInSync(userId, body.agent_id.trim(), body.account_id)
      );
    } catch (error: unknown) {
      if (sendKnownError(error, res)) return undefined;
      throw error;
    }
  })
);

/** POST /api/integrations/linkedin/sync/phase — the export agent reports what it saw. */
router.post(
  '/linkedin/sync/phase',
  authenticateMachineUpload,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = userIdOf(req);
    if (userId === null) return res.status(401).json({ error: 'User not authenticated' });
    try {
      const report = linkedinPhaseReportSchema.parse(req.body);
      return res.json(await service.reportLinkedInAgentPhase(userId, report));
    } catch (error: unknown) {
      if (sendKnownError(error, res)) return undefined;
      throw error;
    }
  })
);

interface UploadRequest extends AuthRequest {
  linkedinBytes?: number;
  linkedinRun?: importer.LinkedInUploadRun;
  linkedinRejected?: boolean;
}

const ABANDONED = 'The LinkedIn upload ended before the whole archive arrived';

/** Count request body bytes as they arrive; an upload that never completes ends failed. */
function countUploadBytes(req: Request, res: Response, next: NextFunction): void {
  const upload = req as UploadRequest;
  upload.linkedinBytes = 0;
  req.on('data', (chunk: Buffer) => {
    upload.linkedinBytes = (upload.linkedinBytes ?? 0) + chunk.length;
    upload.linkedinRun?.received(upload.linkedinBytes);
  });
  res.on('close', () => {
    void upload.linkedinRun?.abandon(ABANDONED);
  });
  next();
}

const storeArchive = linkedinArchiveUpload((req, file, accept) => {
  const upload = req as UploadRequest;
  const userId = userIdOf(upload);
  if (!file.originalname.toLowerCase().endsWith('.zip') || userId === null) {
    upload.linkedinRejected = true;
    accept(null, false);
    return;
  }
  const raw = req.query.account_id;
  const accountId = typeof raw === 'string' && raw.trim() !== '' ? raw : undefined;
  const length = Number(req.headers['content-length']);
  const total = Number.isSafeInteger(length) && length > 0 ? length : null;
  importer.beginLinkedInUpload(userId, accountId, total).then(
    (run) => {
      upload.linkedinRun = run;
      run.received(upload.linkedinBytes ?? 0);
      // The client may have gone away (body cut before its end) while the run was recorded.
      if (req.readableAborted) void run.abandon(ABANDONED);
      accept(null, true);
    },
    (error: unknown) => accept(error instanceof Error ? error : new Error(String(error)))
  );
});

function receiveArchive(req: Request, res: Response, next: NextFunction): void {
  storeArchive(req, res, (error?: unknown) => {
    if (error === undefined || error === null) {
      next();
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    void (req as UploadRequest).linkedinRun?.fail(message);
    if (!sendKnownError(error, res)) next(error);
  });
}

/** POST /api/integrations/linkedin/upload?account_id=<LinkedIn account> */
router.post(
  '/linkedin/upload',
  authenticateMachineUpload,
  countUploadBytes,
  receiveArchive,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const upload = req as UploadRequest;
    const file = req.file;
    const run = upload.linkedinRun;
    if (file === undefined || run === undefined) {
      if (file !== undefined) removeUploadTempFile(file.path);
      const rejected = upload.linkedinRejected === true;
      return res
        .status(400)
        .json({ error: rejected ? 'File must be a .zip file' : 'No file uploaded' });
    }
    try {
      const result = await importer.processLinkedInUpload(run, file.path, file.originalname);
      return res.json({ message: 'LinkedIn data imported successfully', ...result });
    } catch (error: unknown) {
      return res.status(500).json({
        error: 'Failed to parse LinkedIn data',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
);

export default router;
