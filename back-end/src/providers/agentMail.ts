import { createHash, randomInt } from 'node:crypto';
import { createLogger } from './logger';

const log = createLogger('AgentMail');

const DEFAULT_BASE_URL = 'https://api.agentmail.to';
const DEFAULT_DOMAIN = 'agentmail.to';

export interface AgentMailInbox {
  inboxId: string;
  email: string;
  clientId: string;
}

export interface AgentMailEmail {
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
  return process.env.AGENTMAIL_API_KEY?.trim() || '';
}

function baseUrl() {
  return (process.env.AGENTMAIL_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function agentMailDomain() {
  return process.env.AGENTMAIL_DOMAIN?.trim() || DEFAULT_DOMAIN;
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

const MINTED_USERNAME_MAX_ATTEMPTS = 24;

function parseDisplayEmail(value: unknown) {
  if (typeof value !== 'string') return '';
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim();
}

function inboxPathSegment(inboxId: string) {
  return encodeURIComponent(inboxId);
}

export function isAgentMailConfigured() {
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

async function getInbox(inboxId: string): Promise<AgentMailInbox | null> {
  const response = await fetch(`${baseUrl()}/v0/inboxes/${inboxPathSegment(inboxId)}`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    log.warn('AgentMail inbox lookup failed', { inboxId, status: response.status });
    return null;
  }
  const data = (await response.json()) as Record<string, unknown>;
  const email = typeof data.email === 'string' ? data.email : inboxId;
  const resolvedInboxId =
    typeof data.inbox_id === 'string' && data.inbox_id !== '' ? data.inbox_id : email;
  const clientId = typeof data.client_id === 'string' ? data.client_id : '';
  return { inboxId: resolvedInboxId, email, clientId };
}

export async function findAgentMailInbox(inboxId: string): Promise<AgentMailInbox | null> {
  if (!isAgentMailConfigured()) return null;
  return getInbox(inboxId);
}

export async function createMintedInbox(params: {
  userId: string;
  authRealm: string;
  agentName?: string | null;
  usernameGenerator?: () => string;
}): Promise<AgentMailInbox | null> {
  if (!isAgentMailConfigured()) {
    log.warn('AGENTMAIL_API_KEY missing; minted inbox creation skipped', {
      userId: params.userId,
      authRealm: params.authRealm,
    });
    return null;
  }

  const nextUsername =
    params.usernameGenerator ?? (() => randomMintedInboxUsername(params.agentName));
  const inboxDomain = agentMailDomain();
  const displayName = params.agentName?.trim() || 'Rose';

  for (let attempt = 0; attempt < MINTED_USERNAME_MAX_ATTEMPTS; attempt += 1) {
    const username = nextUsername();
    const clientId = mintedInboxClientId(params.userId, params.authRealm, username);
    const expectedEmail = `${username}@${inboxDomain}`;
    const existing = await getInbox(expectedEmail);
    if (existing) continue;

    const response = await fetch(`${baseUrl()}/v0/inboxes`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username,
        domain: inboxDomain,
        display_name: displayName,
        client_id: clientId,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const afterFailureExisting = await getInbox(expectedEmail);
      if (afterFailureExisting) continue;
      throw new Error(
        `AgentMail inbox creation failed: HTTP ${response.status} ${body.slice(0, 300)}`
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    const email = typeof data.email === 'string' ? data.email : '';
    const inboxId =
      typeof data.inbox_id === 'string' && data.inbox_id !== '' ? data.inbox_id : email;
    if (email === '' || inboxId === '') {
      throw new Error('AgentMail inbox creation response missing email or inbox_id');
    }

    return { inboxId, email, clientId };
  }

  throw new Error(
    `AgentMail inbox creation failed after ${MINTED_USERNAME_MAX_ATTEMPTS} username attempts`
  );
}

async function fetchMessage(
  inboxId: string,
  messageId: string
): Promise<Record<string, unknown> | null> {
  const response = await fetch(
    `${baseUrl()}/v0/inboxes/${inboxPathSegment(inboxId)}/messages/${encodeURIComponent(messageId)}`,
    {
      headers: { Authorization: `Bearer ${apiKey()}` },
    }
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    log.warn('AgentMail message fetch failed', { inboxId, messageId, status: response.status });
    return null;
  }
  return (await response.json()) as Record<string, unknown>;
}

export async function fetchAgentMailMessagesSince(params: {
  inboxEmails: string[];
  since: Date;
  limit: number;
}): Promise<AgentMailEmail[]> {
  if (!isAgentMailConfigured() || params.inboxEmails.length === 0) return [];

  const perInboxLimit = Math.max(1, Math.ceil(params.limit / params.inboxEmails.length));
  const messageArrays = await Promise.all(
    params.inboxEmails.map(async (inboxEmail) => {
      try {
        const response = await fetch(
          `${baseUrl()}/v0/inboxes/${inboxPathSegment(inboxEmail)}/messages?` +
            new URLSearchParams({
              after: params.since.toISOString(),
              limit: String(perInboxLimit),
            }),
          { headers: { Authorization: `Bearer ${apiKey()}` } }
        );
        if (response.status === 404) return [];
        if (!response.ok) {
          log.warn('AgentMail inbox message list failed', { inboxEmail, status: response.status });
          return [];
        }
        const data = (await response.json()) as Record<string, unknown>;
        const messages = Array.isArray(data.messages) ? data.messages : [];
        const fullMessages = await Promise.all(
          messages.map(async (message) => {
            const summary = message as Record<string, unknown>;
            const messageId = typeof summary.message_id === 'string' ? summary.message_id : '';
            return messageId ? await fetchMessage(inboxEmail, messageId) : null;
          })
        );
        return fullMessages
          .filter((message): message is Record<string, unknown> => message !== null)
          .map((message) => {
            const timestamp =
              typeof message.timestamp === 'string'
                ? message.timestamp
                : typeof message.created_at === 'string'
                  ? message.created_at
                  : new Date().toISOString();
            const fromEmail = parseDisplayEmail(message.from);
            const messageId =
              typeof message.message_id === 'string'
                ? message.message_id
                : typeof message.id === 'string'
                  ? message.id
                  : null;
            return {
              from: fromEmail,
              fromName: typeof message.from === 'string' ? message.from : null,
              to: Array.isArray(message.to) ? message.to.map(String) : [],
              cc: Array.isArray(message.cc) ? message.cc.map(String) : [],
              subject: typeof message.subject === 'string' ? message.subject : '',
              date: new Date(timestamp),
              messageId,
              bodyText:
                typeof message.text === 'string'
                  ? message.text
                  : typeof message.preview === 'string'
                    ? message.preview
                    : '',
              bodyHtml: typeof message.html === 'string' ? message.html : '',
              credentialId: inboxEmail,
              credentialEmail: inboxEmail,
              isSent: false,
              labels: ['agentmail'],
            };
          });
      } catch (error: unknown) {
        log.warn('AgentMail fetch failed', {
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
