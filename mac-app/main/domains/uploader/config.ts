/**
 * uploader — config layer
 *
 * Constants and integration-type tables for the upload boundary.
 * Layer rule: config may import from own types only.
 */

import type { ChromiumBrowser, UploadStrategy } from './types';

/**
 * Browser identifiers that all upload through the dedicated cookie endpoint.
 * Matched case-sensitively against the `integrationType` argument of
 * {@link Uploader.uploadData}.
 */
export const BROWSER_COOKIE_INTEGRATIONS: readonly ChromiumBrowser[] = [
  'chrome',
  'edge',
  'brave',
  'arc',
  'opera',
  'vivaldi',
  'chromium',
  'atlas',
  'safari',
  'firefox',
] as const;

/** Upload endpoint paths, keyed by the strategy that targets them. */
export const UPLOAD_ENDPOINTS: Record<UploadStrategy, string> = {
  imessage: '/api/integrations/imessage/upload',
  whatsapp: '/api/integrations/whatsapp/upload',
  telegram: '/api/integrations/telegram/upload',
  browserCookies: '/api/integrations/cookies/upload',
  localStorage: '/api/integrations/localStorage/upload',
  fingerprint: '/api/integrations/fingerprint/upload',
  generic: '/api/integrations/upload',
};

/**
 * Endpoint that marks the WhatsApp integration CONNECTED before any messages
 * exist. Kept out of UPLOAD_ENDPOINTS because it carries no payload — it
 * exists purely to break the connect/upload bootstrap deadlock.
 */
export const WHATSAPP_CONNECT_ENDPOINT = '/api/integrations/whatsapp/connect';

/** IPC channel the renderer window listens on for upload progress. */
export const UPLOAD_PROGRESS_CHANNEL = 'upload:progress';

/** Progress percentage emitted just before the network request. */
export const UPLOAD_PROGRESS_START_PERCENT = 50;

/** Progress percentage emitted after the network request settles. */
export const UPLOAD_PROGRESS_DONE_PERCENT = 100;

/** Browser cookie snapshots are idempotent, so transient transport failures are safe to retry. */
export const BROWSER_COOKIE_UPLOAD_MAX_ATTEMPTS = 3;

/** Exponential backoff base for browser-cookie transport retries. */
export const BROWSER_COOKIE_UPLOAD_RETRY_DELAY_MS = 1000;
