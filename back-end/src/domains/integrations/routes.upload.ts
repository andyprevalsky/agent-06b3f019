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
import { sendIMessageDeviceUpload } from './routes.imessageDevice';
import {
  connectTelegramAccount,
  telegramAccountIdSchema,
  telegramConnectSchema,
  uploadTelegramAccountBatch,
} from './uploadService.telegram';

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
    const { contacts, accessedAt, account } = req.body;

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'contacts array is required' });
    }

    // One account per Mac (I1): stored synchronously, 410 for a removed Mac.
    if (account !== undefined) return sendIMessageDeviceUpload(res, userId, contacts, account);

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

/**
 * POST /api/integrations/telegram/connect
 * Body `{ accountId, label?, claimLegacy? }` connects ONE Telegram account
 * (accountId = Telegram user id); an empty body is the legacy single account.
 */
router.post(
  '/telegram/connect',
  authenticateMachineUpload,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const parsed = telegramConnectSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Invalid body' });
    }
    const { accountId } = parsed.data;
    const integration =
      accountId === undefined
        ? await service.processTelegramConnect(userId)
        : await connectTelegramAccount(userId, { ...parsed.data, accountId });
    res.json({ message: 'Telegram connected successfully', integration });
  })
);

/**
 * POST /api/integrations/telegram/upload
 * With `accountId` the batch belongs to that connected account (404 when it
 * is not connected); without it, the legacy single account.
 */
router.post(
  '/telegram/upload',
  authenticateMachineUpload,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { contacts, accessedAt, accountId } = req.body;

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'contacts array is required' });
    }

    if (accountId !== undefined) {
      const parsedAccount = telegramAccountIdSchema.safeParse(accountId);
      if (!parsedAccount.success) return res.status(400).json({ error: 'Invalid accountId' });
      const at = typeof accessedAt === 'string' ? accessedAt : undefined;
      const scoped = await uploadTelegramAccountBatch(userId, parsedAccount.data, contacts, at);
      if (scoped === null) return res.status(404).json({ error: 'TELEGRAM_ACCOUNT_NOT_CONNECTED' });
      return res.json({
        message: 'Telegram payload received, processing in background',
        ...scoped,
      });
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
