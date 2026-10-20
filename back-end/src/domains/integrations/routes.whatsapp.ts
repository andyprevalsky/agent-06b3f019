/**
 * WhatsApp machine-upload routes (plan row I2): one Integration row per linked
 * phone. Split from routes.upload.ts for max-lines compliance.
 *
 *   POST /api/integrations/whatsapp/connect  { accountId?, label?, claimLegacy? }
 *   POST /api/integrations/whatsapp/upload   { contacts, accessedAt?, accountId? }
 *
 * Both ingest the caller machine's data, so both use authenticateMachineUpload.
 */

import { type Response, Router } from 'express';
import { type AuthRequest, authenticateMachineUpload } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service';
import { connectWhatsAppAccount, uploadWhatsAppAccountBatch } from './service.whatsappAccounts';

const router = Router({ mergeParams: true });

/** A WhatsApp account id is the linked phone in E.164 (`+` and 5-20 digits). */
const WHATSAPP_ACCOUNT_ID = /^\+\d{5,20}$/;

function whatsappAccountId(value: unknown): string | null {
  return typeof value === 'string' && WHATSAPP_ACCOUNT_ID.test(value) ? value : null;
}

/**
 * POST /api/integrations/whatsapp/upload  { contacts, accessedAt?, accountId? }
 * With `accountId` (the linked phone) the batch belongs to that connected
 * account (404 when it is not connected); without it, the legacy single account.
 */
router.post(
  '/whatsapp/upload',
  authenticateMachineUpload,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const { contacts, accessedAt, accountId } = req.body;

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'contacts array is required' });
    }

    if (accountId !== undefined) {
      const phone = whatsappAccountId(accountId);
      if (phone === null) return res.status(400).json({ error: 'Invalid accountId' });
      const scoped = await uploadWhatsAppAccountBatch(userId, phone, contacts);
      if (scoped === null) return res.status(404).json({ error: 'WHATSAPP_ACCOUNT_NOT_CONNECTED' });
      return res.json({
        message: 'WhatsApp payload received, processing in background',
        ...scoped,
      });
    }

    const result = await service.processWhatsAppUpload(userId, contacts, accessedAt);
    res.json({
      message: 'WhatsApp payload received, processing in background',
      integration: result.integration,
      jobId: result.jobId,
    });
  })
);

/**
 * POST /api/integrations/whatsapp/connect
 * Body `{ accountId, label?, claimLegacy? }` connects ONE linked phone
 * (claimLegacy: it is the Mac's legacy single auth dir, so it adopts the legacy
 * row and its history); an empty body is the legacy single account.
 */
router.post(
  '/whatsapp/connect',
  authenticateMachineUpload,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user!.id;
    const body = (req.body ?? {}) as {
      accountId?: unknown;
      label?: unknown;
      claimLegacy?: unknown;
    };
    if (body.accountId === undefined) {
      const integration = await service.processWhatsAppConnect(userId);
      return res.json({ message: 'WhatsApp connected successfully', integration });
    }
    const accountId = whatsappAccountId(body.accountId);
    if (accountId === null) return res.status(400).json({ error: 'Invalid accountId' });
    const label =
      typeof body.label === 'string' && body.label.trim() !== '' ? body.label.trim() : null;
    const integration = await connectWhatsAppAccount(userId, {
      accountId,
      label,
      claimLegacy: body.claimLegacy === true,
    });
    return res.json({ message: 'WhatsApp connected successfully', integration });
  })
);

export default router;
