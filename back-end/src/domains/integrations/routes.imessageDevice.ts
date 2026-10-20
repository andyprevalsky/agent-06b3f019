/**
 * Response mapping for a device-scoped iMessage batch (plan row I1), used by
 * POST /api/integrations/imessage/upload when the body carries `account`.
 *
 *   400 invalid account · 200 stored { accountId, jobId, stored } · 410 ACCOUNT_REMOVED
 */

import type { Response } from 'express';
import type { ContactWithMessages } from '../../services/integrations/iMessageParser';
import {
  IMessageAccountRemovedError,
  imessageDeviceAccountSchema,
  processIMessageDeviceUpload,
} from './service.imessageAccounts';

export async function sendIMessageDeviceUpload(
  res: Response,
  userId: string,
  contacts: ContactWithMessages[],
  account: unknown
): Promise<Response> {
  const parsed = imessageDeviceAccountSchema.safeParse(account);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Invalid account' });
  }
  try {
    // The batch is stored before the response so the Mac can advance its cursor.
    const stored = await processIMessageDeviceUpload(userId, contacts, parsed.data);
    return res.json({ message: 'iMessage batch stored', ...stored });
  } catch (error: unknown) {
    if (error instanceof IMessageAccountRemovedError) {
      return res.status(410).json({ error: 'ACCOUNT_REMOVED', accountId: error.accountId });
    }
    throw error;
  }
}
