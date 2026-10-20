/**
 * Integration upload routes — file uploads, messaging uploads, browser data uploads.
 * Split from routes.ts for max-lines compliance.
 */

import { type RequestHandler, type Response, Router } from 'express';
// eslint-disable-next-line no-restricted-imports -- Express file upload middleware, configured per-route
import multer from 'multer';
// eslint-disable-next-line no-restricted-imports -- temp file cleanup for multer uploads
import fs from 'fs';
import { type AuthRequest, authenticateMachineUpload } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import { UPLOAD_LIMITS } from './config';
import * as service from './service';

const log = createLogger('Integrations');
const router = Router({ mergeParams: true });

const upload = multer({
  dest: '/tmp/integration-uploads/',
  limits: UPLOAD_LIMITS,
});

// ---------------------------------------------------------------------------
// File upload routes
// ---------------------------------------------------------------------------

/** POST /api/integrations/upload */
router.post(
  '/upload',
  authenticateMachineUpload,
  upload.single('file') as unknown as RequestHandler,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;
      const { integrationType } = req.body;

      if (req.file === undefined || req.file === null) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      if (integrationType === undefined || integrationType === null || integrationType === '') {
        return res.status(400).json({ error: 'integrationType is required' });
      }

      const integration = await service.processGenericUpload(userId, req.file, integrationType);

      return res.json({
        message: 'File uploaded successfully, processing in background',
        integration,
      });
    } catch (error: unknown) {
      if (req.file !== undefined && req.file !== null) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (cleanupError: unknown) {
          log.error('Error cleaning up file', {
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
      throw error;
    }
  })
);

/** POST /api/integrations/linkedin/upload */
router.post(
  '/linkedin/upload',
  authenticateMachineUpload,
  upload.single('file') as unknown as RequestHandler,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;

      if (req.file === undefined || req.file === null) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const filePath = req.file.path;
      const fileName = req.file.originalname;

      if (!fileName.toLowerCase().endsWith('.zip')) {
        fs.unlinkSync(filePath);
        return res.status(400).json({ error: 'File must be a .zip file' });
      }

      try {
        const result = await service.processLinkedInUpload(userId, filePath, fileName);
        return res.json({ message: 'LinkedIn data imported successfully', ...result });
      } catch (parseError: unknown) {
        return res.status(500).json({
          error: 'Failed to parse LinkedIn data',
          details: parseError instanceof Error ? parseError.message : 'Unknown error',
        });
      }
    } catch (error: unknown) {
      if (req.file !== undefined && req.file !== null) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {
          // expected — file may already be removed
        }
      }
      throw error;
    }
  })
);

/** POST /api/integrations/contacts/upload */
router.post(
  '/contacts/upload',
  authenticateMachineUpload,
  upload.single('file') as unknown as RequestHandler,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;

      if (req.file === undefined || req.file === null) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const filePath = req.file.path;
      const fileName = req.file.originalname;

      if (!fileName.toLowerCase().endsWith('.vcf')) {
        fs.unlinkSync(filePath);
        return res.status(400).json({ error: 'File must be a .vcf file' });
      }

      log.info('VCF file uploaded', { fileName, fileSize: req.file.size });

      const result = await service.processContactsUpload(userId, filePath, fileName);
      return res.json({ message: 'Contacts imported successfully', ...result });
    } catch (error: unknown) {
      if (req.file !== undefined && req.file !== null) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (cleanupError: unknown) {
          log.error('Error cleaning up file', {
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
      throw error;
    }
  })
);

/** POST /api/integrations/email/upload */
router.post(
  '/email/upload',
  authenticateMachineUpload,
  upload.single('file') as unknown as RequestHandler,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const jobId = `email-upload-${Date.now()}`;

    try {
      const userId = req.user!.id;

      if (req.file === undefined || req.file === null) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const filePath = req.file.path;
      const fileName = req.file.originalname;

      if (!fileName.toLowerCase().endsWith('.zip')) {
        fs.unlinkSync(filePath);
        return res.status(400).json({ error: 'File must be a .zip file' });
      }

      log.info('Email ZIP uploaded', { jobId, fileName, fileSize: req.file.size });

      const userEmail = req.user!.email;
      if (userEmail === undefined || userEmail === null || userEmail === '') {
        fs.unlinkSync(filePath);
        return res.status(400).json({ error: 'User email not found in auth token' });
      }

      const result = await service.processEmailZipUpload(userId, userEmail, filePath, jobId);

      return res.json({
        message: 'Emails imported successfully',
        jobId,
        emailsParsed: result.emailsParsed,
        contactsCreated: result.contacts,
        messagesImported: result.messages,
      });
    } catch (error: unknown) {
      if (req.file !== undefined && req.file !== null) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (cleanupError: unknown) {
          log.error('Error cleaning up file', {
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
      throw error;
    }
  })
);

// ---------------------------------------------------------------------------
// Messaging upload routes (iMessage, WhatsApp, Telegram)
// ---------------------------------------------------------------------------

/** POST /api/integrations/imessage/upload */
router.post(
  '/imessage/upload',
  authenticateMachineUpload,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { contacts, accessedAt } = req.body;

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'contacts array is required' });
    }

    const result = await service.processIMessageUpload(userId, contacts, accessedAt);
    res.json({
      message: 'iMessage payload received, processing in background',
      integration: result.integration,
      jobId: result.jobId,
    });
  })
);

/** POST /api/integrations/whatsapp/upload */
router.post(
  '/whatsapp/upload',
  authenticateMachineUpload,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { contacts, accessedAt } = req.body;

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'contacts array is required' });
    }

    const result = await service.processWhatsAppUpload(userId, contacts, accessedAt);
    res.json({
      message: 'WhatsApp payload received, processing in background',
      integration: result.integration,
      jobId: result.jobId,
    });
  })
);

/** POST /api/integrations/whatsapp/connect */
router.post(
  '/whatsapp/connect',
  authenticateMachineUpload,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const integration = await service.processWhatsAppConnect(userId);
    res.json({ message: 'WhatsApp connected successfully', integration });
  })
);

/** POST /api/integrations/telegram/connect */
router.post(
  '/telegram/connect',
  authenticateMachineUpload,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const integration = await service.processTelegramConnect(userId);
    res.json({ message: 'Telegram connected successfully', integration });
  })
);

/** POST /api/integrations/telegram/upload */
router.post(
  '/telegram/upload',
  authenticateMachineUpload,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { contacts, accessedAt } = req.body;

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'contacts array is required' });
    }

    const result = await service.processTelegramUpload(userId, contacts, accessedAt);
    res.json({
      message: 'Telegram payload received, processing in background',
      integration: result.integration,
      jobId: result.jobId,
    });
  })
);

// ---------------------------------------------------------------------------
// Apple passwords file upload
// ---------------------------------------------------------------------------

/** POST /api/integrations/passwords/apple/upload */
router.post(
  '/passwords/apple/upload',
  authenticateMachineUpload,
  upload.single('file') as unknown as RequestHandler,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const file = req.file;

    if (file === undefined || file === null) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Read and parse CSV file
    const csvContent = fs.readFileSync(file.path, 'utf8');

    // Clean up temp file
    fs.unlinkSync(file.path);

    try {
      const result = await service.processApplePasswordsUpload(userId, csvContent);
      return res.json({ message: 'Passwords imported successfully', ...result });
    } catch (parseError: unknown) {
      if (
        parseError instanceof Error &&
        (parseError.message.includes('must have') ||
          parseError.message.includes('must contain') ||
          parseError.message.includes('No valid'))
      ) {
        return res.status(400).json({
          error: parseError.message.includes('No valid')
            ? parseError.message
            : 'Failed to parse CSV file',
          details: parseError.message,
        });
      }
      throw parseError;
    }
  })
);

export default router;
