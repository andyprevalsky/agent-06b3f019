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
import { UPLOAD_ENDPOINTS, WHATSAPP_CONNECT_ENDPOINT } from './config';
import type { IMessageUploadPayload, MessagingUploadOptions, UploadStrategy } from './types';

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

/** POST a JSON `{ contacts, accessedAt }` body to a contacts-upload endpoint. */
async function postContactsJson(
  strategy: Extract<UploadStrategy, 'imessage' | 'whatsapp' | 'telegram'>,
  contacts: unknown,
  accessToken: string,
  options: MessagingUploadOptions = {}
): Promise<UploadHttpResult> {
  const body = {
    contacts,
    accessedAt: options.accessedAt ?? new Date().toISOString(),
    ...(options.syncComplete === false ? { syncComplete: false } : {}),
  };
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
  accessToken: string,
  options: MessagingUploadOptions = {}
): Promise<UploadHttpResult> {
  return postContactsJson('imessage', payload.contacts, accessToken, options);
}

/** POST a WhatsApp contacts blob to the dedicated endpoint. */
export function postWhatsAppContacts(
  contacts: unknown,
  accessToken: string
): Promise<UploadHttpResult> {
  return postContactsJson('whatsapp', contacts, accessToken);
}

/**
 * Mark the WhatsApp integration CONNECTED. Payload-free: called the moment the
 * Baileys socket pairs, so the first history-sync batch has a CONNECTED
 * integration to upload against.
 */
export async function postWhatsAppConnect(accessToken: string): Promise<UploadHttpResult> {
  const response = await fetch(`${config.apiUrl}${WHATSAPP_CONNECT_ENDPOINT}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  return toResult(response);
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
