/**
 * uploader — types layer
 *
 * Type aliases and re-exports for the upload boundary. The wire-level
 * contracts (IMessageData, IMessageUploadContact, IMessageUploadPayload,
 * UploadResult) live in `shared/types/ipc.ts` and are re-exported here so the
 * domain owns its public type surface.
 *
 * Layer rule: types imports nothing from the project source tree other than
 * shared (non-domain) type modules.
 */

export type {
  IMessageData,
  IMessageUploadContact,
  IMessageUploadMessage,
  IMessageUploadPayload,
  UploadResult,
} from '../../../shared/types/ipc';

/**
 * Per-integration wire strategy. Each concrete integration ({@link ChromiumBrowser},
 * `'imessage'`, `'whatsapp'`, etc.) maps to exactly one of these strategies.
 */
export type UploadStrategy =
  | 'imessage'
  | 'whatsapp'
  | 'telegram'
  | 'browserCookies'
  | 'localStorage'
  | 'fingerprint'
  | 'generic';

/** Browser identifiers that route to the shared cookies endpoint. */
export type ChromiumBrowser =
  | 'chrome'
  | 'edge'
  | 'brave'
  | 'arc'
  | 'opera'
  | 'vivaldi'
  | 'chromium'
  | 'atlas'
  | 'safari'
  | 'firefox';
