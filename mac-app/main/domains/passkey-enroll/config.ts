/**
 * Passkey enroll config.
 *
 * The mac-app mints a fresh agent-owned passkey by injecting a pure-WebCrypto
 * software authenticator into an Electron BrowserWindow and letting the user
 * click "Add a passkey" on the target site. Real platform passkeys (iCloud /
 * Secure Enclave) are non-exportable, so minting our own is the only way to get
 * an exportable key we can store server-side. (A CDP virtual authenticator
 * crashes Electron on create(), hence JS injection — see inject-script.ts.)
 */

/** Backend ingestion endpoint (joined with apiUrl at call-site). */
export const PASSKEY_UPLOAD_ENDPOINT = '/api/integrations/passkeys/upload';

/** Tag stored with each minted credential so the agent knows its provenance. */
export const PASSKEY_BROWSER_SOURCE = 'cdp_virtual';

/** Tag stored with passkeys imported from Apple Passwords Credential Exchange. */
export const APPLE_PASSWORDS_PASSKEY_SOURCE = 'apple_passwords';

/** How often to check the page for a newly-minted credential. */
export const POLL_INTERVAL_MS = 1500;

/** Max time to wait for the user to log in + add a passkey before giving up. */
export const ENROLL_TIMEOUT_MS = 8 * 60 * 1000;

export const ENROLL_WINDOW = {
  width: 1100,
  height: 820,
  title: 'Add agent passkey',
} as const;
