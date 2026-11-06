/**
 * What a code-agent sandbox's rejected login means for the stored credential.
 *
 * A sandbox receives a copy of one leased access token and never refreshes it
 * (claudeCredentials.ts / gptCredentials.ts): the owning device refreshes and
 * re-uploads. A provider 401 inside the sandbox is therefore one of:
 *
 *   held token ≠ stored token  → replaced: the device re-synced after the lease
 *   held token expired         → expired: the device's next sync replaces it
 *   held token live            → revoked: the login needs reconnecting
 *
 * Only `revoked` may disable the stored login. The ws-server reports the held
 * token as a fingerprint (never the token itself).
 */
import crypto from 'crypto';

export type LoginRejection = 'revoked' | 'expired' | 'replaced' | 'unverified';

/** Provider and server clocks may disagree slightly about an expiry instant. */
const EXPIRY_SKEW_MS = 60 * 1000;

/** The stored login a rejection is compared against: its access token and expiry (epoch ms). */
export type StoredLogin = { accessToken: string; expiresAt: number | null };

/** The digest a sandbox reports for the token it holds (ws-server CREDENTIAL_FINGERPRINT). */
export function credentialFingerprint(accessToken: string): string {
  return crypto.createHash('sha256').update(accessToken).digest('hex').slice(0, 16);
}

/** A credential-feedback `credential` field: absent, or a fingerprint-sized string. */
export function isFeedbackCredential(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= 64);
}

/**
 * Classify a rejection against the stored login now. `stored` is `undefined`
 * when this server cannot read credentials at all (no decryption key): nothing
 * is disabled on an unverified rejection. A row with no readable credential
 * (`null`) cannot be served either way and is `revoked`; a rejection without a
 * fingerprint (an older sandbox) compares expiry only.
 */
export function classifyLoginRejection(
  stored: StoredLogin | null | undefined,
  heldFingerprint: string | undefined,
  now: number = Date.now()
): LoginRejection {
  if (stored === undefined) return 'unverified';
  if (stored === null) return 'revoked';
  if (heldFingerprint && credentialFingerprint(stored.accessToken) !== heldFingerprint) {
    return 'replaced';
  }
  if (stored.expiresAt !== null && stored.expiresAt <= now + EXPIRY_SKEW_MS) return 'expired';
  return 'revoked';
}
