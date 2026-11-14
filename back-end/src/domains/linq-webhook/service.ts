import {
  getLinqWebhookConfig,
  MESSAGE_NAMESPACE,
  PROCESSING_TTL_MS,
  PROCESSED_TTL_MS,
} from './config';
import { provisionUserByPhone } from './repo';
import { parseLinqPayload, validateLinqSignature } from './service.validation';
import type { LinqSignatureHeaders, LinqSupervisorHandlers } from './types';
import { acquireLease, releaseLease, renewLease } from '../../providers/sharedState';
import { isLinqEnabled, rememberLinqChat } from '../../providers/linq';
import { createSignupBonusCredit } from '../../providers/credits';
import { createLogger } from '../../providers/logger';

const log = createLogger('Linq Webhook');

export class InvalidSignatureError extends Error {}
export class InvalidPayloadError extends Error {}
export class WebhookUnavailableError extends Error {}

export async function handleInboundLinq(
  input: { rawBody: Buffer | undefined; headers: LinqSignatureHeaders },
  supervisor: LinqSupervisorHandlers
): Promise<{ ok: true }> {
  const requestStart = Date.now();
  const config = getLinqWebhookConfig();
  // Mandatory in every environment. Never recreate the body from parsed JSON.
  if (!validateLinqSignature(input.headers, input.rawBody, config.signingSecret)) {
    throw new InvalidSignatureError('Invalid signature');
  }
  if (!isLinqEnabled() || config.fromPhone === undefined || config.fromPhone === '') {
    throw new WebhookUnavailableError('Linq webhook is not configured');
  }
  let body: unknown;
  try {
    body = JSON.parse(input.rawBody!.toString('utf8'));
  } catch {
    throw new InvalidPayloadError('Invalid JSON');
  }
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const event = body as Record<string, unknown>;
    if (event.event_type === 'message.failed') {
      const data =
        typeof event.data === 'object' && event.data !== null
          ? (event.data as Record<string, unknown>)
          : {};
      log.error('Linq message delivery failed', {
        messageId: data.message_id,
        code: data.code,
        reason: data.reason,
        traceId: event.trace_id,
      });
      return { ok: true };
    }
  }
  const message = parseLinqPayload(body, config.fromPhone);
  if (!message || !isLinqEnabled(message.fromPhone)) return { ok: true };

  // Key by provider message identity, not delivery/event identity: retries and
  // redeliveries under a new event ID must still route exactly once.
  const key = `${config.fromPhone}:${message.messageId}`;
  const token = await acquireLease(MESSAGE_NAMESPACE, key, PROCESSING_TTL_MS);
  if (token === null) return { ok: true };
  try {
    // Persist before provisioning, /clear, or supervisor work can emit a reply.
    await rememberLinqChat(message.fromPhone, { chatId: message.chatId, service: message.service });
    const { user, created } = await provisionUserByPhone(message.fromPhone);
    if (created) {
      try {
        await createSignupBonusCredit(user.userId);
      } catch (error) {
        log.error('Failed to create signup bonus credit', {
          userId: user.userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (message.messageBody.toLowerCase() === '/clear') {
      await supervisor.handleClearCommand(user.userId, message.fromPhone);
    } else {
      await supervisor.routeToSupervisor(user.userId, message, requestStart);
    }
  } catch (error) {
    await releaseLease(MESSAGE_NAMESPACE, key, token).catch((releaseError: unknown) =>
      log.warn('Failed to release inbound claim', { error: String(releaseError) })
    );
    throw error;
  }
  // Already handed off: a bookkeeping failure must not turn a routed message
  // into an immediate retry. A crashed handler's short claim expires naturally.
  await renewLease(MESSAGE_NAMESPACE, key, token, PROCESSED_TTL_MS).catch((error: unknown) =>
    log.warn('Failed to extend inbound claim', { error: String(error) })
  );
  return { ok: true };
}
