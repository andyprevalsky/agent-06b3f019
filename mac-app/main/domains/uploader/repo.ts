/**
 * uploader — repo layer
 *
 * Sole HTTP boundary for the upload domain. Every outbound POST to
 * `/api/integrations/*` lives here. Callers pass typed args; this layer
 * executes the fetch, normalizes the response, and returns a typed result.
 *
 * Layer rule: repo imports its own types/config plus shared providers
 * (main/base/config for the apiUrl) only.
 */

import { config } from '../../base/config';
import { UPLOAD_ENDPOINTS, WHATSAPP_CONNECT_ENDPOINT, integrationProgressPath } from './config';
import type { IMessageUploadPayload, UploadStrategy } from './types';

/** Result of a single upload HTTP call — unwrapped for the service layer. */
export interface UploadHttpResult {
  /** True when the server returned 2xx. */
  ok: boolean;
  /** HTTP status text, useful for error messages. */
  statusText: string;
}

/** Build the absolute URL for a given upload strategy. */
function urlFor(strategy: UploadStrategy): string {
  return `${config.apiUrl}${UPLOAD_ENDPOINTS[strategy]}`;
}

/** Normalize a fetch Response into an UploadHttpResult. */
function toResult(response: Response): UploadHttpResult {
  return { ok: response.ok, statusText: response.statusText };
}

/** POST a JSON `{ contacts, accessedAt, ...extra }` body to a contacts-upload endpoint. */
async function postContactsJson(
  strategy: Extract<UploadStrategy, 'imessage' | 'whatsapp' | 'telegram'>,
  contacts: unknown,
  accessToken: string,
  extra: Record<string, string> = {}
): Promise<UploadHttpResult> {
  const body = { contacts, accessedAt: new Date().toISOString(), ...extra };
  const response = await fetch(urlFor(strategy), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return toResult(response);
}

/** POST an iMessage payload (already grouped into contacts). */
export function postIMessagePayload(
  payload: IMessageUploadPayload,
  accessToken: string
): Promise<UploadHttpResult> {
  return postContactsJson('imessage', payload.contacts, accessToken);
}

/**
 * POST a WhatsApp contacts blob to the dedicated endpoint. `accountId` (the
 * linked phone) attributes the messages to that account; null = legacy row.
 */
export function postWhatsAppContacts(
  contacts: unknown,
  accessToken: string,
  accountId: string | null = null
): Promise<UploadHttpResult> {
  return postContactsJson(
    'whatsapp',
    contacts,
    accessToken,
    accountId === null ? {} : { accountId }
  );
}

/**
 * Mark a WhatsApp account CONNECTED. Called the moment its Baileys socket
 * pairs, so the first history-sync batch has a CONNECTED integration to upload
 * against. Without `account` the legacy single-account row is marked.
 */
export async function postWhatsAppConnect(
  accessToken: string,
  account: { accountId: string; label: string } | null = null
): Promise<UploadHttpResult> {
  const response = await fetch(`${config.apiUrl}${WHATSAPP_CONNECT_ENDPOINT}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    ...(account !== null && { body: JSON.stringify(account) }),
  });
  return toResult(response);
}

/** Raw response of one per-account progress write. */
export interface ProgressHttpResult {
  status: number;
  body: unknown;
}

/** POST /api/integrations/:provider/accounts/:accountId/progress */
export async function postIntegrationProgress(
  provider: string,
  accountId: string,
  body: unknown,
  accessToken: string
): Promise<ProgressHttpResult> {
  const url = `${config.apiUrl}${integrationProgressPath(provider, accountId)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

/** POST a Telegram contacts blob to the dedicated endpoint. */
export function postTelegramContacts(
  contacts: unknown,
  accessToken: string
): Promise<UploadHttpResult> {
  return postContactsJson('telegram', contacts, accessToken);
}

/** POST an encrypted multipart payload to one of the multipart upload endpoints. */
async function postMultipart(
  strategy: Exclude<UploadStrategy, 'imessage' | 'whatsapp' | 'telegram'>,
  formData: FormData,
  accessToken: string
): Promise<UploadHttpResult> {
  const response = await fetch(urlFor(strategy), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: formData,
  });
  return toResult(response);
}

/** POST browser cookies (encrypted) to the shared cookies endpoint. */
export function postBrowserCookies(
  formData: FormData,
  accessToken: string
): Promise<UploadHttpResult> {
  return postMultipart('browserCookies', formData, accessToken);
}

/** POST chrome localStorage (encrypted) to the dedicated endpoint. */
export function postLocalStorage(
  formData: FormData,
  accessToken: string
): Promise<UploadHttpResult> {
  return postMultipart('localStorage', formData, accessToken);
}

/** POST browser fingerprint (encrypted) to the dedicated endpoint. */
export function postFingerprint(
  formData: FormData,
  accessToken: string
): Promise<UploadHttpResult> {
  return postMultipart('fingerprint', formData, accessToken);
}

/** POST any other integration type (encrypted) to the generic endpoint. */
export function postGeneric(formData: FormData, accessToken: string): Promise<UploadHttpResult> {
  return postMultipart('generic', formData, accessToken);
}
