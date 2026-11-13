/** Access requests never bind/enable a device or launch setup. */
import { sendSms } from '../../providers/smsQueue';
import { IPHONE_ADMIN_PHONE } from '../../providers/phoneAccountPolicy';
import { connection } from './repo.connection';
import { claimNotification, finishNotification } from './repo.accessRequest';
import { IPhoneError } from './types';

export type AccessRequestSmsSender = typeof sendSms;
export async function requestAccess(userId: string, send: AccessRequestSmsSender = sendSms) {
  const current = await connection(userId);
  if (current.enabled) return current;
  const claim = await claimNotification(userId);
  if (claim !== null) {
    let sent = false;
    try {
      const identity = [claim.user.name, claim.user.email, claim.user.phone]
        .filter((value) => value !== null && value.trim() !== '')
        .join(' · ');
      const result = await send(
        IPHONE_ADMIN_PHONE,
        `${identity || userId} wants iPhone access (account ${userId}).`
      );
      if (!result.success) throw new IPhoneError(503, 'Unable to send iPhone access notification');
      sent = true;
    } finally {
      // Preserve the request even on delivery failure; a retry may reclaim failed delivery.
      await finishNotification(claim, sent);
    }
  }
  return connection(userId);
}
