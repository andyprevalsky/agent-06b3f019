/** Linq is the SMS surface's iMessage/RCS/SMS transport. Never retry ambiguous sends. */
import { createHash, randomUUID } from 'node:crypto';
import { createLogger } from './logger';
import { getEphemeral, putEphemeral } from './sharedState';
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
  const recipients = process.env.LINQ_RECIPIENTS?.split(',')
    .map((value) => canonicalPhone(value))
    .filter(Boolean);
  return phone === undefined || !recipients?.length || recipients.includes(canonicalPhone(phone));
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
      'Idempotency-Key': randomUUID(),
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
    const chat = await getLinqChat(phone);
    const path = chat ? `/chats/${encodeURIComponent(chat.chatId)}/messages` : '/chats';
    const body = chat ? { message } : { from: process.env.LINQ_FROM_PHONE, to: [phone], message };
    options.abortSignal?.throwIfAborted();
    options.onDeliveryAttempt?.();
    attempted = true;
    const response = await request(path, body, options);
    const result = (await response.json()) as {
      chat_id?: string;
      chat?: { id?: string; message?: { id?: string } };
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
    if (!response.ok)
      return {
        success: false,
        statusCode: response.status,
        definitiveFailure:
          response.status >= 400 && response.status < 500 && response.status !== 408,
        error: `Linq API error ${response.status}: ${JSON.stringify(result.error ?? result)}`,
      };
    const messageSid = result.message?.id ?? result.chat?.message?.id;
    if (!messageSid)
      return {
        success: false,
        definitiveFailure: false,
        error: 'Linq accepted the request without a message ID',
      };
    const chatId = result.chat_id ?? result.chat?.id ?? chat?.chatId;
    if (chatId)
      await rememberLinqChat(phone, {
        chatId,
        service: result.message?.service ?? chat?.service ?? 'unknown',
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
  const parts: Array<Record<string, unknown>> = [{ type: 'text', value: text }];
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

/** Refresh while the supervisor works and always clear on completion or failure. */
export async function startLinqTyping(phone: string): Promise<() => Promise<void>> {
  if (!isLinqEnabled(phone) || (await shouldMockMessagingSend('linq')) !== null)
    return async () => undefined;
  const chat = await getLinqChat(phone);
  if (!chat || chat.service !== 'iMessage') return async () => undefined;
  const path = `/chats/${encodeURIComponent(chat.chatId)}/typing`;
  const refresh = async () => {
    await request(path, undefined).catch((error: unknown) =>
      log.warn('Linq typing failed', { error: String(error) })
    );
  };
  await refresh();
  const timer = setInterval(() => {
    void refresh();
  }, 60000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await request(path, undefined, {}, 'DELETE').catch((error: unknown) =>
      log.warn('Linq typing stop failed', { error: String(error) })
    );
  };
}
