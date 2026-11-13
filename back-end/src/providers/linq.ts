/** Linq is the SMS surface's iMessage/RCS/SMS transport. Never retry ambiguous sends. */
import { createHash, randomUUID } from 'node:crypto';
import { createLogger } from './logger';
import { getEphemeral, putEphemeral, deleteEphemeral, withSerializedLock } from './sharedState';
import { shouldMockMessagingSend } from './smsTransportMock';
import { archiveJson } from './traceArchive';
import { canonicalPhone } from './phoneAccountLookup';

const log = createLogger('Linq');
const BASE_URL = 'https://api.linqapp.com/api/partner/v3';
const CHAT_NAMESPACE = 'linq-chat';
const CHAT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export interface LinqChat {
  chatId: string;
  service: string;
}
export interface LinqSendOptions {
  /** Reuse for retries of one logical operation. Omitted keys are new per call;
   * legacy sendSms callers therefore have no cross-call retry deduplication. */
  idempotencyKey?: string;
  archiveRootAgentId?: string;
  archiveContext?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  onDeliveryAttempt?: () => void;
  mediaUrl?: string;
  replyToMessageId?: string;
}
export interface LinqSendResult {
  success: boolean;
  messageSid?: string;
  error?: string;
  definitiveFailure?: boolean;
  statusCode?: number;
}
export function isLinqEnabled(phone?: string): boolean {
  if (process.env.SMS_PROVIDER !== 'linq') return false;
  const configured = process.env.LINQ_RECIPIENTS?.trim();
  if (!configured) return true; // unset or blank: unrestricted rollout
  const recipients = configured
    .split(',')
    .map((value) => canonicalPhone(value))
    .filter(
      (value): value is string => typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value)
    );
  // A configured allowlist with no valid number must not widen to everyone.
  if (!recipients.length) return false;
  return phone === undefined || recipients.includes(canonicalPhone(phone) ?? '');
}
function chatKey(phone: string) {
  return `${process.env.LINQ_FROM_PHONE ?? ''}:${canonicalPhone(phone) ?? phone}`;
}
export function getLinqChat(phone: string): Promise<LinqChat | undefined> {
  return getEphemeral<LinqChat>(CHAT_NAMESPACE, chatKey(phone));
}
export function rememberLinqChat(phone: string, chat: LinqChat): Promise<void> {
  return putEphemeral(CHAT_NAMESPACE, chatKey(phone), { ...chat }, CHAT_TTL_MS);
}
function forgetLinqChat(phone: string): Promise<void> {
  return deleteEphemeral(CHAT_NAMESPACE, chatKey(phone));
}

async function request(
  path: string,
  body: Record<string, unknown> | undefined,
  options: LinqSendOptions = {},
  method = 'POST'
) {
  const token = process.env.LINQ_TOKEN ?? process.env.LINQ_API_KEY;
  if (!token) throw new Error('LINQ_TOKEN is not configured');
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: options.abortSignal ?? AbortSignal.timeout(30000),
  });
}

export async function sendLinqPayload(
  phone: string,
  message: Record<string, unknown>,
  options: LinqSendOptions = {}
): Promise<LinqSendResult> {
  phone = canonicalPhone(phone) ?? phone;
  if (!/^\+[1-9]\d{6,14}$/.test(phone))
    return {
      success: false,
      definitiveFailure: true,
      error: 'Linq requires an E.164 phone number',
    };
  let attempted = false;
  try {
    const reason = await shouldMockMessagingSend('linq', options.archiveRootAgentId);
    if (reason !== null) {
      options.onDeliveryAttempt?.();
      return {
        success: true,
        messageSid: `linq_mock_${createHash('sha256').update(JSON.stringify({ phone, message })).digest('hex').slice(0, 24)}`,
      };
    }
    if (!process.env.LINQ_FROM_PHONE || !(process.env.LINQ_TOKEN ?? process.env.LINQ_API_KEY)) {
      return {
        success: false,
        definitiveFailure: true,
        error: 'Linq credentials or sender number are not configured',
      };
    }
    const idempotencyKey = options.idempotencyKey ?? message.idempotency_key ?? randomUUID();
    if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.trim() === '' ||
      idempotencyKey.length > 255
    ) {
      return {
        success: false,
        definitiveFailure: true,
        error: 'Linq idempotency key must contain 1–255 characters',
      };
    }
    // Linq's documented deduplication field belongs inside message, not a header.
    // Copy the caller's message so repeated operations do not mutate each other.
    message = { ...message, idempotency_key: idempotencyKey };
    const chat = await getLinqChat(phone);
    // Managed creation permits links in the first substantive message, unlike
    // /chats. Do not bootstrap with a greeting or retry through another endpoint.
    // This endpoint selects the line; only cache a returned configured-line chat.
    const path = chat ? `/chats/${encodeURIComponent(chat.chatId)}/messages` : '/messages';
    const body = chat ? { message } : { to: [phone], message };
    options.abortSignal?.throwIfAborted();
    options.onDeliveryAttempt?.();
    attempted = true;
    const response = await request(path, body, options);
    const result = (await response.json()) as {
      from?: string;
      chat_id?: string;
      service?: string;
      chat?: { id?: string; service?: string; message?: { id?: string; service?: string } };
      message?: { id?: string; service?: string };
      error?: unknown;
    };
    if (options.archiveRootAgentId) {
      await archiveJson({
        rootAgentId: options.archiveRootAgentId,
        objectPath: `provider/sms/linq/${Date.now()}-${randomUUID()}.json.gz.enc`,
        value: {
          provider: 'linq',
          request: { path, body },
          response: result,
          status_code: response.status,
          context: options.archiveContext ?? {},
        },
      }).catch((error: unknown) => log.warn('Linq archive failed', { error: String(error) }));
    }
    if (!response.ok) {
      // A cached chat Linq no longer knows would trap every later send; drop it so
      // the next send resolves a chat again. This send is not retried here.
      if (chat && response.status === 404)
        await forgetLinqChat(phone).catch((error: unknown) =>
          log.warn('Linq stale chat eviction failed', { error: String(error) })
        );
      return {
        success: false,
        statusCode: response.status,
        definitiveFailure:
          response.status >= 400 && response.status < 500 && response.status !== 408,
        error: `Linq API error ${response.status}: ${JSON.stringify(result.error ?? result)}`,
      };
    }
    const messageSid = result.message?.id ?? result.chat?.message?.id;
    if (!messageSid)
      return {
        success: false,
        definitiveFailure: false,
        error: 'Linq accepted the request without a message ID',
      };
    const chatId = result.chat_id ?? result.chat?.id ?? chat?.chatId;
    if (
      !chat &&
      result.from !== undefined &&
      canonicalPhone(result.from) !== canonicalPhone(process.env.LINQ_FROM_PHONE)
    ) {
      // Already accepted: returning a failure here could duplicate the message.
      // Inbound ownership still requires LINQ_FROM_PHONE; never bind another
      // sending line's chat into that configured line's cache.
      log.warn('Linq managed send selected another line; chat not cached', {
        from: result.from,
        chatId,
      });
      return { success: true, messageSid };
    }
    if (chatId)
      await rememberLinqChat(phone, {
        chatId,
        service:
          result.chat?.service ??
          result.service ??
          result.message?.service ??
          result.chat?.message?.service ??
          chat?.service ??
          'unknown',
      }).catch((error: unknown) =>
        log.warn('Linq chat persistence failed after accepted send', { error: String(error) })
      );
    return { success: true, messageSid };
  } catch (error) {
    return {
      success: false,
      definitiveFailure: !attempted,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function sendLinqMessage(
  phone: string,
  text: string,
  options: LinqSendOptions = {}
): Promise<LinqSendResult> {
  // Linq rejects an empty text part; media-only messages carry just the media.
  const parts: Array<Record<string, unknown>> = text ? [{ type: 'text', value: text }] : [];
  if (options.mediaUrl) parts.push({ type: 'media', url: options.mediaUrl });
  return sendLinqPayload(
    phone,
    {
      parts,
      ...(options.replyToMessageId ? { reply_to: { message_id: options.replyToMessageId } } : {}),
    },
    options
  );
}

export async function sendLinqReaction(messageId: string, emoji: string): Promise<LinqSendResult> {
  try {
    if ((await shouldMockMessagingSend('linq')) !== null) return { success: true };
    if (!messageId)
      return { success: false, definitiveFailure: true, error: 'Missing inbound message ID' };
    const response = await request(`/messages/${encodeURIComponent(messageId)}/reactions`, {
      operation: 'add',
      type: 'custom',
      custom_emoji: emoji,
    });
    return {
      success: response.ok,
      ...(!response.ok ? { error: `Linq reaction rejected (${response.status})` } : {}),
    };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

/** Latest run owns typing across instances; completion cannot clear a newer run. */
export async function startLinqTyping(phone: string): Promise<() => Promise<void>> {
  if (!isLinqEnabled(phone) || (await shouldMockMessagingSend('linq')) !== null)
    return async () => undefined;
  const chat = await getLinqChat(phone);
  if (!chat || chat.service !== 'iMessage') return async () => undefined;
  const path = `/chats/${encodeURIComponent(chat.chatId)}/typing`;
  const namespace = 'linq-typing-owner';
  const key = chat.chatId;
  const owner = randomUUID();
  const lockKey = `${namespace}:${key}`;
  const send = async (method = 'POST') => {
    await request(path, undefined, { abortSignal: AbortSignal.timeout(3000) }, method).catch(
      (error: unknown) => log.warn('Linq typing failed', { error: String(error) })
    );
  };
  await withSerializedLock(lockKey, async () => {
    await putEphemeral(namespace, key, { owner }, 120000);
    await send();
  });
  const timer = setInterval(() => {
    void withSerializedLock(lockKey, async () => {
      const current = await getEphemeral<{ owner: string }>(namespace, key);
      if (current?.owner !== owner) {
        clearInterval(timer);
        return;
      }
      await putEphemeral(namespace, key, { owner }, 120000);
      await send();
    }).catch((error: unknown) => log.warn('Linq typing refresh failed', { error: String(error) }));
  }, 60000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await withSerializedLock(lockKey, async () => {
      const current = await getEphemeral<{ owner: string }>(namespace, key);
      if (current?.owner !== owner) return;
      await deleteEphemeral(namespace, key);
      await send('DELETE');
    }).catch((error: unknown) => log.warn('Linq typing stop failed', { error: String(error) }));
  };
}
