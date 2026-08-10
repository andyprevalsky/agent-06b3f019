/**
 * uploader — service layer
 *
 * Business logic for routing per-integration uploads: payload building,
 * strategy resolution, and encryption of binary/cookie/fingerprint bodies.
 *
 * Layer rule: service may import own repo, own types, own config, and shared
 * providers (here: `main/base/crypto` for payload encryption).
 */

import { Crypto, type EncryptedData } from '../../base/crypto';
import {
  BROWSER_COOKIE_INTEGRATIONS,
  BROWSER_COOKIE_UPLOAD_MAX_ATTEMPTS,
  BROWSER_COOKIE_UPLOAD_RETRY_DELAY_MS,
} from './config';
import { getErrorMessageOrFallback } from '../../../shared/utils/error';
import {
  postBrowserCookies,
  postFingerprint,
  postGeneric,
  postIMessagePayload,
  postLocalStorage,
  postTelegramContacts,
  postWhatsAppContacts,
  type UploadHttpResult,
} from './repo';
import type {
  IMessageData,
  IMessageUploadContact,
  IMessageUploadPayload,
  UploadStrategy,
} from './types';

// ---------------------------------------------------------------------------
// Payload building (iMessage)
// ---------------------------------------------------------------------------

/** Narrow an arbitrary value to `IMessageUploadContact` (already-structured). */
function isStructuredContact(item: unknown): item is IMessageUploadContact {
  return (
    item !== null &&
    typeof item === 'object' &&
    Array.isArray((item as { messages?: unknown }).messages)
  );
}

/** Create a fresh contact record from the first message that references it. */
function newContact(msg: IMessageData, handle: string, isEmail: boolean): IMessageUploadContact {
  return {
    contact_id: handle,
    contact_name: msg.contact_name ?? null,
    phoneNumber: isEmail ? null : handle,
    email: msg.contact_email ?? (isEmail ? handle : null),
    firstName: msg.contact_firstName ?? null,
    lastName: msg.contact_lastName ?? null,
    company: msg.contact_company ?? null,
    title: msg.contact_title ?? null,
    emailAddresses: msg.contact_emailAddresses ?? [],
    messages: [],
  };
}

/** Merge contact-level metadata from a later message into an existing contact. */
function mergeContact(contact: IMessageUploadContact, msg: IMessageData, isEmail: boolean): void {
  contact.contact_name = contact.contact_name ?? msg.contact_name ?? null;
  contact.firstName = contact.firstName ?? msg.contact_firstName ?? null;
  contact.lastName = contact.lastName ?? msg.contact_lastName ?? null;
  contact.company = contact.company ?? msg.contact_company ?? null;
  contact.title = contact.title ?? msg.contact_title ?? null;

  const incomingEmail = msg.contact_email ?? null;
  if (contact.email === null && (incomingEmail !== null || isEmail)) {
    contact.email = incomingEmail ?? (isEmail ? contact.contact_id : null);
  }

  const extras = msg.contact_emailAddresses;
  if (extras !== undefined && extras !== null && extras.length > 0) {
    const existingEmails = new Set(contact.emailAddresses ?? []);
    for (const email of extras) {
      if (!existingEmails.has(email)) {
        existingEmails.add(email);
        contact.emailAddresses = Array.from(existingEmails);
      }
    }
  }
}

/**
 * Build the iMessage upload payload. Accepts either already-grouped
 * contacts or raw per-message rows; in the raw case, groups by contact handle.
 */
export function buildIMessagePayload(
  data: IMessageData[] | IMessageUploadContact[]
): IMessageUploadPayload {
  if (!Array.isArray(data)) {
    return { contacts: [] };
  }

  if (data.every(isStructuredContact)) {
    return { contacts: data };
  }

  const rows = data as IMessageData[];
  const contactMap = new Map<string, IMessageUploadContact>();

  for (const msg of rows) {
    const handle = (msg.contact_id ?? '').trim();
    if (handle === '') continue;

    const isEmail = handle.includes('@');
    let contact = contactMap.get(handle);
    if (contact === undefined) {
      contact = newContact(msg, handle, isEmail);
      contactMap.set(handle, contact);
    } else {
      mergeContact(contact, msg, isEmail);
    }

    contact.messages.push({
      id: msg.id,
      text: msg.text,
      date: msg.date,
      is_from_me: msg.is_from_me,
      contactHandle: handle,
    });
  }

  return { contacts: Array.from(contactMap.values()) };
}

// ---------------------------------------------------------------------------
// Strategy resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an integration-type identifier (the external, human-readable name
 * passed through the IPC boundary) into an internal {@link UploadStrategy}.
 */
export function resolveStrategy(integrationType: string): UploadStrategy {
  if (integrationType === 'imessage') return 'imessage';
  if (integrationType === 'whatsapp') return 'whatsapp';
  if (integrationType === 'telegram') return 'telegram';
  if (integrationType === 'chrome_local_storage') return 'localStorage';
  if (integrationType === 'browser_fingerprint') return 'fingerprint';
  if ((BROWSER_COOKIE_INTEGRATIONS as readonly string[]).includes(integrationType)) {
    return 'browserCookies';
  }
  return 'generic';
}

// ---------------------------------------------------------------------------
// Upload dispatch
// ---------------------------------------------------------------------------

/** Build a fresh FormData body from an already-encrypted payload. */
function buildEncryptedFormDataFromEnvelope(
  { encrypted, iv, key }: EncryptedData,
  extraFields: Record<string, string> = {}
): FormData {
  const formData = new FormData();
  formData.append('data', encrypted);
  formData.append('iv', iv);
  formData.append('key', key);
  for (const [field, value] of Object.entries(extraFields)) {
    formData.append(field, value);
  }
  return formData;
}

/** Build a FormData body for an encrypted integration upload. */
function buildEncryptedFormData(data: unknown, extraFields: Record<string, string> = {}): FormData {
  return buildEncryptedFormDataFromEnvelope(Crypto.encrypt(data), extraFields);
}

/**
 * Execute the upload for a resolved {@link UploadStrategy}. Encrypts the body
 * (where applicable), calls the repo layer, and returns the HTTP result.
 */
export async function dispatchUpload(
  strategy: UploadStrategy,
  integrationType: string,
  data: unknown,
  accessToken: string
): Promise<UploadHttpResult> {
  if (strategy === 'imessage') {
    const payload = buildIMessagePayload(data as IMessageData[] | IMessageUploadContact[]);
    return postIMessagePayload(payload, accessToken);
  }

  if (strategy === 'whatsapp') {
    return postWhatsAppContacts(data, accessToken);
  }

  if (strategy === 'telegram') {
    return postTelegramContacts(data, accessToken);
  }

  if (strategy === 'browserCookies') {
    const formData = buildEncryptedFormData(data, { browser: integrationType });
    return postBrowserCookies(formData, accessToken);
  }

  if (strategy === 'localStorage') {
    return postLocalStorage(buildEncryptedFormData(data), accessToken);
  }

  if (strategy === 'fingerprint') {
    return postFingerprint(buildEncryptedFormData(data), accessToken);
  }

  return postGeneric(buildEncryptedFormData(data, { integrationType }), accessToken);
}

/**
 * Dispatch an upload with the transport policy appropriate for its strategy.
 * Complete browser-cookie snapshots are idempotent, so a thrown transport
 * exception is retried. HTTP responses and every other strategy remain
 * one-shot and retain their existing result semantics.
 */
export async function dispatchUploadWithTransportRetry(
  strategy: UploadStrategy,
  integrationType: string,
  data: unknown,
  accessToken: string
): Promise<UploadHttpResult> {
  if (strategy !== 'browserCookies') {
    return dispatchUpload(strategy, integrationType, data, accessToken);
  }

  // Encryption belongs before the transport boundary: programming/data-shaping
  // failures are terminal, while each fetch attempt gets a fresh FormData body.
  const encrypted = Crypto.encrypt(data);

  for (let attempt = 1; attempt <= BROWSER_COOKIE_UPLOAD_MAX_ATTEMPTS; attempt++) {
    const formData = buildEncryptedFormDataFromEnvelope(encrypted, {
      browser: integrationType,
    });
    try {
      return await postBrowserCookies(formData, accessToken);
    } catch (error) {
      if (attempt === BROWSER_COOKIE_UPLOAD_MAX_ATTEMPTS) throw error;

      console.warn(
        `[Uploader] Browser-cookie transport attempt ${attempt}/${BROWSER_COOKIE_UPLOAD_MAX_ATTEMPTS} failed:`,
        getErrorMessageOrFallback(error)
      );
      const delay = BROWSER_COOKIE_UPLOAD_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error('Browser-cookie upload exhausted without a result');
}
