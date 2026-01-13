import { Router } from 'express';
import multer from 'multer';
import { AuthRequest, authenticate } from '../middleware/auth';
import {
  processUploadedFile,
  getSignedUrl,
  MAX_FILE_SIZE,
  FilePointer,
} from '../lib/storage';

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
router.post('/', authenticate, attachmentUpload.single('file') as any, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;

    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    // Process the uploaded file (stored under userId, not agent-scoped)
    const filePointer = await processUploadedFile(
      userId,
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype
    );

    console.log(`[Upload] Uploaded file for user ${userId}: ${filePointer.original_filename} (${filePointer.size_bytes} bytes)`);

    res.status(201).json({
      file_pointer: filePointer,
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      error: 'Failed to upload file',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/upload/:fileId/url - Get a signed URL for a file
// Verifies the storage path starts with the user's ID for security
router.get('/:fileId/url', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const storagePath = req.query.storage_path as string;

    if (!storagePath) {
      res.status(400).json({ error: 'storage_path query parameter is required' });
      return;
    }

    // Verify the storage path belongs to this user
    if (!storagePath.startsWith(`${userId}/`)) {
      res.status(403).json({ error: 'Access denied to this file' });
      return;
    }

    // Generate signed URL (1 hour expiry)
    const signedUrl = await getSignedUrl(storagePath, 3600);

    res.json({
      signed_url: signedUrl,
      expires_in: 3600,
    });
  } catch (error) {
    console.error('Get signed URL error:', error);
    res.status(500).json({
      error: 'Failed to generate signed URL',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
