/**
 * Project secret envelopes (env files, linked config, git artifacts).
 *
 * Reuses the credential envelope (RSA-OAEP-SHA256 + AES-256-GCM) that stores
 * Claude/GPT/Plaid credentials. The public key is DERIVED from the configured
 * `CLAUDE_CREDENTIAL_DECRYPTION_KEY`, and clients (rose-sync CLI, mac app)
 * fetch it from `GET /api/projects/sync-key`, so a client can never encrypt
 * with a drifted hard-coded key. Plaintext never reaches a log line: callers
 * get `null` on failure and the envelope decrypt helper logs only the reason.
 */
import { createHmac, createPrivateKey, createPublicKey } from '../crypto';
import { encryptPasswordForStorage } from '../credentialEnvelope';
import { decryptCredentialEnvelope } from '../claudeCredentials';

export class ProjectSecretsUnavailableError extends Error {
  constructor() {
    super('CLAUDE_CREDENTIAL_DECRYPTION_KEY is not configured; project secrets are unavailable');
  }
}

let cachedKey: { privateB64: string; publicPem: string } | null = null;

function privateKeyB64(): string {
  const key = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  if (!key) throw new ProjectSecretsUnavailableError();
  return key;
}

/** PEM public key matching the backend's credential decryption key. */
export function projectSyncPublicKeyPem(): string {
  const privateB64 = privateKeyB64();
  if (cachedKey?.privateB64 === privateB64) return cachedKey.publicPem;
  const pem = Buffer.from(privateB64, 'base64').toString('utf8');
  const publicPem = createPublicKey(createPrivateKey(pem))
    .export({ type: 'spki', format: 'pem' })
    .toString();
  cachedKey = { privateB64, publicPem };
  return publicPem;
}

/** Short, stable id of the active key so clients can detect rotation. */
export function projectSyncKeyId(): string {
  return createHmac('sha256', 'rose-project-sync-key-id')
    .update(projectSyncPublicKeyPem())
    .digest('hex')
    .slice(0, 16);
}

export function encryptProjectSecret(plaintext: string): string {
  return encryptPasswordForStorage(plaintext, projectSyncPublicKeyPem());
}

/** Binary artifacts (git bundle, patch) are base64-wrapped inside the envelope. */
export function encryptProjectBinary(content: Buffer): string {
  return encryptProjectSecret(content.toString('base64'));
}

export function decryptProjectSecret(envelope: string): string | null {
  return decryptCredentialEnvelope(envelope, privateKeyB64());
}

export function decryptProjectBinary(envelope: string): Buffer | null {
  const text = decryptProjectSecret(envelope);
  return text === null ? null : Buffer.from(text, 'base64');
}

/**
 * Salted content fingerprint used for incremental re-sync. The client computes
 * the same HMAC with the per-project salt, so unchanged files are never
 * re-uploaded; the salt keeps fingerprints unlinkable across projects.
 */
export function projectContentFingerprint(salt: string, content: Buffer | string): string {
  return createHmac('sha256', salt).update(content).digest('hex');
}
