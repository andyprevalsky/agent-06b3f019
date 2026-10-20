/**
 * Typed client for /api/phones (back-end/src/domains/phones): iPhones attached
 * to the user's Macs through macOS iPhone Mirroring. Exactly one holder (an
 * agent or the user) controls a phone at a time.
 *
 *   GET  /api/phones                    -> { phones: PhoneState[] }
 *   GET  /api/phones/:id                -> PhoneState (cheap poll)
 *   POST /api/phones/:id/take-control   -> PhoneState (re-post to renew the user lease)
 *   POST /api/phones/:id/release        -> PhoneState (no-op unless the user holds it)
 *   GET  /api/phones/:id/frame?after=N  -> JPEG + X-Phone-Frame-* headers, or 204
 *
 * Errors carry the backend's `code` (409: PHONE_IN_USE_BY_USER,
 * PHONE_IN_USE_BY_AGENT, PHONE_LEASE_LOST, PHONE_OFFLINE, ...).
 */
import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

export interface PhoneAgentHolder {
  kind: 'agent';
  agentId: string;
  agentTitle: string | null;
  leaseExpiresAt: string;
}
export interface PhoneUserHolder {
  kind: 'user';
  leaseExpiresAt: string;
}
export type PhoneHolder = PhoneAgentHolder | PhoneUserHolder | { kind: null };

/**
 * Holder guards. The app tsconfig runs without strictNullChecks, where a
 * `kind: null` member defeats discriminated-union narrowing on `kind`.
 */
export function isAgentHolder(holder: PhoneHolder): holder is PhoneAgentHolder {
  return holder.kind === 'agent';
}
export function isUserHolder(holder: PhoneHolder): holder is PhoneUserHolder {
  return holder.kind === 'user';
}

export interface PhoneState {
  id: string;
  name: string;
  model: string | null;
  kind: 'iphone_mirroring';
  macDeviceId: string;
  /** The Mac heartbeat is fresh and iPhone Mirroring reports connected. */
  online: boolean;
  lastSeenAt: string;
  holder: PhoneHolder;
  /** Agent whose control the user took; control returns to it on release. */
  resumeAgent: { agentId: string; agentTitle: string | null } | null;
  /** Latest relayed screen frame, if one is fresh. */
  frame: { seq: number; capturedAt: string; width: number; height: number } | null;
}

export type PhoneControlErrorCode =
  | 'PHONE_IN_USE_BY_USER'
  | 'PHONE_IN_USE_BY_AGENT'
  | 'PHONE_LEASE_LOST'
  | 'PHONE_OFFLINE'
  | 'PHONE_CONTROL_TAKEN'
  | 'PHONE_CONTROL_CONFLICT'
  | 'PHONE_NOT_FOUND';

export class PhoneApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'PhoneApiError';
  }
}

/** One relayed screen frame (GET /:id/frame). */
export interface PhoneFrame {
  seq: number;
  blob: Blob;
  /** Pixel size from X-Phone-Frame-Width/Height; 0 when the Mac did not send it. */
  width: number;
  height: number;
}

const phonesUrl = (path = '') => `${API_BASE_WITH_PATH}/phones${path}`;
const phonePath = (phoneId: string, suffix = '') => `/${encodeURIComponent(phoneId)}${suffix}`;

async function toPhoneError(response: Response, fallback: string): Promise<PhoneApiError> {
  let code: string | null = null;
  let message = `${fallback} (${response.status})`;
  try {
    const body = (await response.json()) as { code?: unknown; error?: unknown };
    if (typeof body.code === 'string') code = body.code;
    if (typeof body.error === 'string' && body.error !== '') message = body.error;
  } catch {
    // Non-JSON error body: keep the fallback message.
  }
  return new PhoneApiError(message, response.status, code);
}

async function phoneJson<T>(
  path: string,
  init: { method?: 'GET' | 'POST'; signal?: AbortSignal },
  fallback: string,
): Promise<T> {
  const response = await fetch(phonesUrl(path), {
    method: init.method ?? 'GET',
    headers: getAuthHeaders(),
    signal: init.signal,
  });
  if (!response.ok) throw await toPhoneError(response, fallback);
  return (await response.json()) as T;
}

export async function listPhones(signal?: AbortSignal): Promise<PhoneState[]> {
  const body = await phoneJson<{ phones?: PhoneState[] }>('', { signal }, 'Failed to list phones');
  return body.phones ?? [];
}

export function getPhone(phoneId: string, signal?: AbortSignal): Promise<PhoneState> {
  return phoneJson<PhoneState>(phonePath(phoneId), { signal }, 'Failed to read phone');
}

export function takePhoneControl(phoneId: string, signal?: AbortSignal): Promise<PhoneState> {
  return phoneJson<PhoneState>(
    phonePath(phoneId, '/take-control'),
    { method: 'POST', signal },
    'Failed to take control of the phone',
  );
}

export function releasePhoneControl(phoneId: string, signal?: AbortSignal): Promise<PhoneState> {
  return phoneJson<PhoneState>(
    phonePath(phoneId, '/release'),
    { method: 'POST', signal },
    'Failed to release the phone',
  );
}

function positiveHeader(response: Response, name: string): number {
  const value = Number(response.headers.get(name));
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * Newest screen frame strictly after `after` (null = the latest one), fetched
 * with the Authorization header so it can be shown through a blob URL.
 * Resolves null on 204 (no newer frame).
 */
export async function fetchPhoneFrame(
  phoneId: string,
  after: number | null,
  signal?: AbortSignal,
): Promise<PhoneFrame | null> {
  const query = after === null ? '' : `?after=${after}`;
  const response = await fetch(phonesUrl(phonePath(phoneId, `/frame${query}`)), {
    headers: getAuthHeaders(),
    signal,
  });
  if (response.status === 204) return null;
  if (!response.ok) throw await toPhoneError(response, 'Failed to read the phone screen');
  const seq = Number(response.headers.get('X-Phone-Frame-Seq'));
  return {
    seq: Number.isFinite(seq) ? seq : (after ?? 0),
    blob: await response.blob(),
    width: positiveHeader(response, 'X-Phone-Frame-Width'),
    height: positiveHeader(response, 'X-Phone-Frame-Height'),
  };
}
