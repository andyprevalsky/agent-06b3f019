import { type Response, Router } from 'express';
import multer from 'multer';
import { asyncHandler } from '../../utils/asyncHandler';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import {
  uploadFile,
  getFileSignedUrl,
  ContentMismatchError,
  AccessDeniedError,
  MAX_FILE_SIZE,
} from './service';

const log = createLogger('Upload');
const router = Router();

// Configure multer for attachment uploads (memory storage for processing)
const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
  },
});

// POST /api/upload - Upload a file attachment to Supabase Storage (not agent-scoped)
// Files are stored under userId, allowing them to be reused across agents
router.post(
  '/',
  authenticate,
  attachmentUpload.single('file') as unknown as Parameters<typeof router.post>[1],
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;

    if (req.file === undefined) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    try {
      const filePointer = await uploadFile(
        userId,
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      );

      res.status(201).json({
        file_pointer: filePointer,
      });
    } catch (error) {
      if (error instanceof ContentMismatchError) {
        res.status(400).json({
          error: 'File content does not match its type',
          details: error.message,
        });
        return;
      }
      log.error('Upload error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: 'Failed to upload file',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
);

// GET /api/upload/:fileId/url - Get a signed URL for a file
// Verifies the storage path starts with the user's ID for security
router.get(
  '/:fileId/url',
  authenticate,
  asyncHandler<AuthRequest>(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const storagePath =
      typeof req.query.storage_path === 'string' ? req.query.storage_path : undefined;

    if (storagePath === undefined || storagePath === '') {
      res.status(400).json({ error: 'storage_path query parameter is required' });
      return;
    }

    try {
      const result = await getFileSignedUrl(userId, storagePath);
      res.json(result);
    } catch (error) {
      if (error instanceof AccessDeniedError) {
        res.status(403).json({ error: error.message });
        return;
      }
      log.error('Get signed URL error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: 'Failed to generate signed URL',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
);

export default router;
