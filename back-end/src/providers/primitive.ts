import { createHash, randomInt } from 'node:crypto';
import { createLogger } from './logger';

const log = createLogger('Primitive');

const DEFAULT_BASE_URL = 'https://api.primitive.dev/v1';
const DEFAULT_DOMAIN = 'mail.roselabs.ai';

export interface PrimitiveInbox {
  inboxId: string;
  email: string;
  clientId: string;
}

export interface PrimitiveAttachment {
  filename: string;
  contentType: string;
  /** Raw attachment bytes; base64-encoded at the transport boundary. */
  content: Buffer;
}

export interface PrimitiveEmail {
  from: string;
  fromName: string | null;
  to: string[];
  cc: string[];
  subject: string;
  date: Date;
  messageId: string | null;
  bodyText: string;
  bodyHtml: string;
  credentialId: string;
  credentialEmail: string;
  isSent: boolean;
  labels: string[];
}

function apiKey() {
  return process.env.PRIMITIVE_API_KEY?.trim() || '';
}

function baseUrl() {
  return (process.env.PRIMITIVE_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function primitiveDomain() {
  return process.env.PRIMITIVE_DOMAIN?.trim() || DEFAULT_DOMAIN;
}

function shortHash(input: string, length: number) {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

const MINTED_KEYWORDS = [
  'amber',
  'cedar',
  'clover',
  'ember',
  'harbor',
  'maple',
  'meadow',
  'river',
  'spruce',
  'willow',
] as const;

function parseDisplayEmail(value: unknown) {
  if (typeof value !== 'string') return '';
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim();
}

export function isPrimitiveConfigured() {
  return apiKey() !== '';
}

export function mintedInboxClientId(userId: string, authRealm: string, username?: string) {
  const seed = username ? `${userId}:${authRealm}:${username}` : `${userId}:${authRealm}`;
  return `navi-minted-${shortHash(seed, 24)}`;
}

function normalizeLocalPartToken(value: string, fallback: string, maxLength: number) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.+/g, '.');
  return (normalized || fallback).slice(0, maxLength).replace(/\.+$/g, '') || fallback;
}

export function mintedInboxUsername(
  agentName: string | null | undefined,
  keyword: string,
  digits: number
) {
  const agentPart = normalizeLocalPartToken(agentName?.trim() || '', 'rose', 40);
  const keywordPart = normalizeLocalPartToken(keyword, 'river', 16).replace(/\./g, '');
  const numericSuffix = String(Math.abs(Math.trunc(digits)) % 100).padStart(2, '0');
  return `${agentPart}.${keywordPart}${numericSuffix}`.slice(0, 64).replace(/\.+$/g, '');
}

function randomMintedInboxUsername(agentName: string | null | undefined) {
  const keyword = MINTED_KEYWORDS[randomInt(MINTED_KEYWORDS.length)];
  const digits = randomInt(100);
  return mintedInboxUsername(agentName, keyword, digits);
}

/**
 * Build the full minted address for a user.
 *
 * Primitive is a catch-all domain: every `*@mail.roselabs.ai` address routes
 * into the same org mailbox with no per-inbox provisioning. Because addresses
 * are virtual, two users sharing an agent name could otherwise generate the
 * same local part (`rose.cedar47@...`) and read each other's mail. We append a
 * deterministic per-user suffix so every user's minted address is globally
 * unique while remaining stable across regenerations for that user.
 */
export function mintedInboxAddress(userId: string, username: string) {
  const suffix = shortHash(userId, 8);
  return `${username}.${suffix}@${primitiveDomain()}`;
}

/**
 * "Mint" an inbox. Unlike AgentMail there is no inbox object to provision —
 * the address is a pure routing key under the catch-all domain, so this makes
 * no network call and is not bounded by any inbox quota.
 */
export async function createMintedInbox(params: {
  userId: string;
  authRealm: string;
  agentName?: string | null;
  usernameGenerator?: () => string;
}): Promise<PrimitiveInbox | null> {
  if (!isPrimitiveConfigured()) {
    log.warn('PRIMITIVE_API_KEY missing; minted inbox creation skipped', {
      userId: params.userId,
      authRealm: params.authRealm,
    });
    return null;
  }

  const nextUsername =
    params.usernameGenerator ?? (() => randomMintedInboxUsername(params.agentName));
  const username = nextUsername();
  const email = mintedInboxAddress(params.userId, username);
  const clientId = mintedInboxClientId(params.userId, params.authRealm, username);
  return { inboxId: email, email, clientId };
}

/**
 * Resolve a minted inbox by address. Under the catch-all domain any address on
 * our managed domain is always receivable, so we accept it without a lookup;
 * addresses on other domains are not ours.
 */
export async function findMintedInbox(inboxId: string): Promise<PrimitiveInbox | null> {
  if (!isPrimitiveConfigured()) return null;
  const email = inboxId.trim().toLowerCase();
  if (!email.endsWith(`@${primitiveDomain().toLowerCase()}`)) return null;
  return { inboxId: email, email, clientId: '' };
}

async function fetchEmailDetail(id: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${baseUrl()}/emails/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    log.warn('Primitive email detail fetch failed', { id, status: response.status });
    return null;
  }
  const body = (await response.json()) as Record<string, unknown>;
  const data = body.data;
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
}

function parsedCcAddresses(detail: Record<string, unknown>): string[] {
  const parsed = detail.parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  const cc = (parsed as Record<string, unknown>).cc;
  if (!Array.isArray(cc)) return [];
  return cc
    .map((entry) => {
      if (entry && typeof entry === 'object') {
        const address = (entry as Record<string, unknown>).address;
        return typeof address === 'string' ? address : '';
      }
      return typeof entry === 'string' ? entry : '';
    })
    .filter((address) => address !== '');
}

export async function fetchPrimitiveMessagesSince(params: {
  inboxEmails: string[];
  since: Date;
  limit: number;
}): Promise<PrimitiveEmail[]> {
  if (!isPrimitiveConfigured() || params.inboxEmails.length === 0) return [];

  const perInboxLimit = Math.max(1, Math.ceil(params.limit / params.inboxEmails.length));
  const messageArrays = await Promise.all(
    params.inboxEmails.map(async (inboxEmail) => {
      const target = inboxEmail.trim().toLowerCase();
      try {
        const response = await fetch(
          `${baseUrl()}/emails?` +
            new URLSearchParams({
              search: inboxEmail,
              date_from: params.since.toISOString(),
              limit: String(perInboxLimit),
            }),
          { headers: { Authorization: `Bearer ${apiKey()}` } }
        );
        if (response.status === 404) return [];
        if (!response.ok) {
          log.warn('Primitive inbox message list failed', { inboxEmail, status: response.status });
          return [];
        }
        const body = (await response.json()) as Record<string, unknown>;
        const summaries = Array.isArray(body.data) ? body.data : [];
        // `search` matches subject/sender/recipient — keep only exact recipient hits so
        // one agent never sees another minted inbox's mail.
        const matching = summaries.filter((summary) => {
          const recipient =
            summary && typeof summary === 'object'
              ? (summary as Record<string, unknown>).recipient
              : null;
          return typeof recipient === 'string' && recipient.trim().toLowerCase() === target;
        });
        const details = await Promise.all(
          matching.map(async (summary) => {
            const id = (summary as Record<string, unknown>).id;
            return typeof id === 'string' ? await fetchEmailDetail(id) : null;
          })
        );
        return details
          .filter((detail): detail is Record<string, unknown> => detail !== null)
          .map((detail) => {
            const receivedAt =
              typeof detail.received_at === 'string'
                ? detail.received_at
                : typeof detail.created_at === 'string'
                  ? detail.created_at
                  : new Date().toISOString();
            const fromEmail =
              typeof detail.from_email === 'string' && detail.from_email !== ''
                ? detail.from_email
                : parseDisplayEmail(detail.from_header);
            return {
              from: fromEmail,
              fromName: typeof detail.from_header === 'string' ? detail.from_header : null,
              to: [typeof detail.recipient === 'string' ? detail.recipient : inboxEmail],
              cc: parsedCcAddresses(detail),
              subject: typeof detail.subject === 'string' ? detail.subject : '',
              date: new Date(receivedAt),
              messageId: typeof detail.message_id === 'string' ? detail.message_id : null,
              bodyText: typeof detail.body_text === 'string' ? detail.body_text : '',
              bodyHtml: typeof detail.body_html === 'string' ? detail.body_html : '',
              credentialId: inboxEmail,
              credentialEmail: inboxEmail,
              isSent: false,
              labels: ['primitive'],
            };
          });
      } catch (error: unknown) {
        log.warn('Primitive fetch failed', {
          inboxEmail,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    })
  );

  return messageArrays
    .flat()
    .filter((email) => email.date.getTime() >= params.since.getTime())
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, params.limit);
}

/**
 * Combined raw attachment bytes Primitive accepts on a single /send-mail call.
 * Mirrors the documented 30 MiB relay ceiling.
 */
export const PRIMITIVE_MAX_ATTACHMENT_BYTES = 31457280;

/**
 * Send one outbound email through Primitive's relay.
 *
 * `to` is a single recipient by API contract — callers fan out themselves so a
 * per-recipient rejection stays isolated instead of failing the whole send.
 * Resolves true when the relay accepted the message, false otherwise; the
 * caller decides whether a partial failure is fatal.
 */
export async function sendPrimitiveEmail(params: {
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  attachments?: PrimitiveAttachment[];
}): Promise<boolean> {
  if (!isPrimitiveConfigured()) {
    log.warn('PRIMITIVE_API_KEY missing; outbound send skipped', { to: params.to });
    return false;
  }

  const attachments = params.attachments ?? [];
  const totalBytes = attachments.reduce((sum, item) => sum + item.content.byteLength, 0);
  if (totalBytes > PRIMITIVE_MAX_ATTACHMENT_BYTES) {
    log.error('Primitive send rejected locally: attachments exceed relay ceiling', {
      to: params.to,
      totalBytes,
    });
    return false;
  }

  try {
    const sendMailUrl = `${baseUrl()}/send-mail`;
    const response = await fetch(sendMailUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: params.from,
        to: params.to,
        subject: params.subject,
        body_text: params.bodyText,
        ...(params.bodyHtml === undefined ? {} : { body_html: params.bodyHtml }),
        ...(attachments.length === 0
          ? {}
          : {
              attachments: attachments.map((item) => ({
                filename: item.filename,
                content_type: item.contentType,
                content_base64: item.content.toString('base64'),
              })),
            }),
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      let requestOrigin: string | undefined;
      try {
        requestOrigin = new URL(sendMailUrl).origin;
      } catch {
        // Failure provenance must not change the send result or expose an invalid URL.
      }
      log.error('Primitive send failed', {
        to: params.to,
        status: response.status,
        requestOrigin,
        detail: detail.slice(0, 200),
      });
      return false;
    }

    log.info('Primitive send accepted', { to: params.to, subject: params.subject.slice(0, 200) });
    return true;
  } catch (error: unknown) {
    log.error('Primitive send threw', {
      to: params.to,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
