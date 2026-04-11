/**
 * SMS Utilities
 *
 * Core SMS/MMS sending via Surge API and user phone lookup.
 */

import { prisma } from './database';
import { createLogger } from './logger';
import { logTruncate } from '../utils/log';

const log = createLogger('SMS');

interface SurgeMessageResponse {
  id: string;
  body?: string;
  [key: string]: unknown;
}

/**
 * Send SMS via Surge API (internal helper)
 */
export async function sendSms(
  phoneNumber: string,
  message: string
): Promise<{ success: boolean; messageSid?: string; error?: string }> {
  const apiKey = process.env.SURGE_API_KEY;
  const accountId = process.env.SURGE_ACCOUNT_ID;

  if (!apiKey || !accountId) {
    log.error('Surge credentials not configured');
    return { success: false, error: 'Surge not configured' };
  }

  try {
    const response = await fetch(`https://api.surge.app/accounts/${accountId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: phoneNumber,
        body: message,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error('Surge API error', { status: response.status, error: logTruncate(errorText) });
      return { success: false, error: `Surge API error: ${response.status}` };
    }

    const result = (await response.json()) as SurgeMessageResponse;
    log.info('Sent via Surge', {
      messageId: result.id,
      phone: phoneNumber.substring(0, 7) + '****',
    });

    return { success: true, messageSid: result.id };
  } catch (error) {
    log.error('Error sending', { error: error instanceof Error ? error.message : String(error) });
    return { success: false, error: String(error) };
  }
}

/* c8 ignore start -- sendMms is effectively unused; only caller is a dead code path in auth/service.ts */
/**
 * Send MMS with media attachment via Surge (for vCard, images, etc.)
 */
export async function sendMms(
  phoneNumber: string,
  message: string,
  mediaUrl: string
): Promise<{ success: boolean; messageSid?: string; error?: string }> {
  const apiKey = process.env.SURGE_API_KEY;
  const accountId = process.env.SURGE_ACCOUNT_ID;

  if (!apiKey || !accountId) {
    log.error('Surge credentials not configured');
    return { success: false, error: 'Surge not configured' };
  }

  try {
    const response = await fetch(`https://api.surge.app/accounts/${accountId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: phoneNumber,
        body: message,
        attachments: [{ url: mediaUrl }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error('Surge API error', { status: response.status, error: logTruncate(errorText) });
      return { success: false, error: `Surge API error: ${response.status}` };
    }

    const result = (await response.json()) as SurgeMessageResponse;
    log.info('Sent via Surge', {
      messageId: result.id,
      phone: phoneNumber.substring(0, 7) + '****',
    });

    return { success: true, messageSid: result.id };
  } catch (error) {
    log.error('Error sending', { error: error instanceof Error ? error.message : String(error) });
    return { success: false, error: String(error) };
  }
}
/* c8 ignore stop */

/**
 * Get user's phone number by userId
 */
export async function getUserPhone(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { userId },
    select: { phone: true },
  });
  return user?.phone || null;
}
