/**
 * SMS Utilities
 *
 * Core SMS/MMS sending via Surge API and user phone lookup.
 */

import crypto from 'node:crypto';
import { prisma } from './database';
import { createLogger } from './logger';
import { logTruncate } from '../utils/log';
import { archiveJson } from './traceArchive';

const log = createLogger('SMS');

/**
 * Per-message Surge overrides applied to every outbound send.
 *
 * `link_shortening: 'disabled'` stops Surge rewriting our branded roselabs.ai
 * links into generic `srgv.co` shortlinks. Carriers filter generic shortener
 * domains as "unwanted or malicious" (Surge failure_reason `message_filtered`),
 * which silently dropped every link-bearing SMS (agent_started/completion/
 * auth/agentcard). Sending the branded link verbatim matches the domain the
 * A2P campaign is registered under and clears the carrier filter.
 * See back-end/scripts/repro-surge-link-shortening.ts.
 */
const SURGE_MESSAGE_SETTINGS = { link_shortening: 'disabled' } as const;

interface SurgeMessageResponse {
  id: string;
  body?: string;
  [key: string]: unknown;
}

interface SmsArchiveOptions {
  archiveRootAgentId?: string;
  archiveContext?: Record<string, unknown>;
}

async function archiveSmsTransportBoundary(params: {
  rootAgentId?: string;
  requestBody: Record<string, unknown>;
  response: unknown;
  statusCode?: number;
  success: boolean;
  context?: Record<string, unknown>;
}): Promise<void> {
  const rootAgentId = params.rootAgentId;
  if (rootAgentId === undefined || rootAgentId === '') return;
  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify({ request: params.requestBody, ts: Date.now() }))
    .digest('hex')
    .slice(0, 24);
  try {
    await archiveJson({
      rootAgentId,
      objectPath: `provider/sms/surge/${Date.now()}-${fingerprint}.json.gz.enc`,
      value: {
        provider: 'surge',
        request: {
          method: 'POST',
          url: '/accounts/{accountId}/messages',
          body: params.requestBody,
        },
        response: params.response,
        status_code: params.statusCode,
        success: params.success,
        context: params.context ?? {},
      },
    });
  } catch (error) {
    log.warn('SMS provider archive failed', {
      rootAgentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Send SMS via Surge API (internal helper)
 */
export async function sendSms(
  phoneNumber: string,
  message: string,
  options: SmsArchiveOptions = {}
): Promise<{
  success: boolean;
  messageSid?: string;
  error?: string;
  definitiveFailure?: boolean;
}> {
  const apiKey = process.env.SURGE_API_KEY;
  const accountId = process.env.SURGE_ACCOUNT_ID;

  if (!apiKey || !accountId) {
    log.error('Surge credentials not configured');
    return { success: false, error: 'Surge not configured', definitiveFailure: true };
  }

  const requestBody = {
    to: phoneNumber,
    body: message,
    settings: SURGE_MESSAGE_SETTINGS,
  };

  try {
    const response = await fetch(`https://api.surge.app/accounts/${accountId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      let errorText: string;
      try {
        errorText = await response.text();
      } catch (error) {
        errorText = `Unable to read Surge error response: ${error instanceof Error ? error.message : String(error)}`;
      }
      log.error('Surge API error', { status: response.status, error: logTruncate(errorText) });
      await archiveSmsTransportBoundary({
        rootAgentId: options.archiveRootAgentId,
        requestBody,
        response: { error: errorText },
        statusCode: response.status,
        success: false,
        context: options.archiveContext,
      });
      return {
        success: false,
        error: `Surge API error: ${response.status}`,
        definitiveFailure: true,
      };
    }

    const result = (await response.json()) as SurgeMessageResponse;
    await archiveSmsTransportBoundary({
      rootAgentId: options.archiveRootAgentId,
      requestBody,
      response: result,
      statusCode: response.status,
      success: true,
      context: {
        ...(options.archiveContext ?? {}),
        message_id: result.id,
      },
    });
    log.info('Sent via Surge', {
      messageId: result.id,
      phone: phoneNumber.substring(0, 7) + '****',
    });

    return { success: true, messageSid: result.id };
  } catch (error) {
    log.error('Error sending', { error: error instanceof Error ? error.message : String(error) });
    await archiveSmsTransportBoundary({
      rootAgentId: options.archiveRootAgentId,
      requestBody,
      response: { error: error instanceof Error ? error.message : String(error) },
      success: false,
      context: options.archiveContext,
    });
    return { success: false, error: String(error) };
  }
}

/**
 * Send MMS with media attachment via Surge (for vCard, images, etc.)
 */
export async function sendMms(
  phoneNumber: string,
  message: string,
  mediaUrl: string,
  options: SmsArchiveOptions = {}
): Promise<{ success: boolean; messageSid?: string; error?: string }> {
  const apiKey = process.env.SURGE_API_KEY;
  const accountId = process.env.SURGE_ACCOUNT_ID;

  if (!apiKey || !accountId) {
    log.error('Surge credentials not configured');
    return { success: false, error: 'Surge not configured' };
  }

  const requestBody = {
    to: phoneNumber,
    body: message,
    attachments: [{ url: mediaUrl }],
    settings: SURGE_MESSAGE_SETTINGS,
  };

  try {
    const response = await fetch(`https://api.surge.app/accounts/${accountId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error('Surge API error', { status: response.status, error: logTruncate(errorText) });
      await archiveSmsTransportBoundary({
        rootAgentId: options.archiveRootAgentId,
        requestBody,
        response: { error: errorText },
        statusCode: response.status,
        success: false,
        context: options.archiveContext,
      });
      return { success: false, error: `Surge API error: ${response.status}` };
    }

    const result = (await response.json()) as SurgeMessageResponse;
    await archiveSmsTransportBoundary({
      rootAgentId: options.archiveRootAgentId,
      requestBody,
      response: result,
      statusCode: response.status,
      success: true,
      context: {
        ...(options.archiveContext ?? {}),
        message_id: result.id,
      },
    });
    log.info('Sent via Surge', {
      messageId: result.id,
      phone: phoneNumber.substring(0, 7) + '****',
    });

    return { success: true, messageSid: result.id };
  } catch (error) {
    log.error('Error sending', { error: error instanceof Error ? error.message : String(error) });
    await archiveSmsTransportBoundary({
      rootAgentId: options.archiveRootAgentId,
      requestBody,
      response: { error: error instanceof Error ? error.message : String(error) },
      success: false,
      context: options.archiveContext,
    });
    return { success: false, error: String(error) };
  }
}

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
