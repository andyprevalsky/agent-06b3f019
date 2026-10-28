/**
 * Environment configuration for the compute-grants domain.
 *
 * All `process.env` access for this domain lives here, per the repo-wide rule
 * that domains read configuration in one place rather than scattering lookups
 * through logic.
 *
 * There is a single key. The public half of the credential keypair is DERIVED
 * from the private key (see `credentialPublicKeyPem`) rather than configured
 * separately -- a second variable would be one more thing to drift out of sync
 * across Render, Fly and Vercel.
 */

import { createPrivateKey, createPublicKey } from 'node:crypto';

/**
 * Base64-encoded RSA private key PEM used for credential envelopes.
 * Read lazily so importing this module never throws at startup in environments
 * that legitimately have no compute grants configured.
 */
export function credentialDecryptionKeyB64(): string {
  const key = process.env.CLAUDE_CREDENTIAL_DECRYPTION_KEY;
  if (key === undefined || key.length === 0) {
    throw new Error(
      'CLAUDE_CREDENTIAL_DECRYPTION_KEY is required for compute grants. ' +
        'Refusing to read or persist token material without it.'
    );
  }
  return key;
}

/** Public half, derived from the configured private key. */
export function credentialPublicKeyPem(): string {
  const privateKeyPem = Buffer.from(credentialDecryptionKeyB64(), 'base64').toString('utf8');
  return createPublicKey(createPrivateKey(privateKeyPem)).export({
    type: 'spki',
    format: 'pem',
  }) as string;
}

/**
 * Which remote-browser provider the compute-grants domain uses.
 *
 * Kernel is the default; Steel, Browser Use and Tilion remain selectable via
 * COMPUTE_GRANT_BROWSER_PROVIDER so a provider outage cannot block account
 * connect or grant recovery -- the two paths whose failure silently pushes every
 * request onto paid models.
 */
export function computeGrantBrowserProvider(): 'kernel' | 'steel' | 'browser-use' | 'tilion' {
  const configured = process.env.COMPUTE_GRANT_BROWSER_PROVIDER?.trim();
  const selected = configured === undefined || configured === '' ? 'kernel' : configured;
  // Domain config cannot import the browser provider layer. Match its rollout
  // flag parser so disabling Browser Use also returns compute grants to Kernel.
  const flag = process.env.BROWSER_AGENT_BROWSER_USE_ENABLED;
  const browserUseEnabled =
    flag !== undefined && ['1', 'true', 'yes', 'on', 'enabled'].includes(flag.trim().toLowerCase());
  if (selected === 'browser-use' && !browserUseEnabled) {
    return 'kernel';
  }
  // Same parser as BROWSER_AGENT_TILION_ENABLED in providers/browser/config.ts.
  const tilionFlag = process.env.BROWSER_AGENT_TILION_ENABLED;
  const tilionEnabled =
    tilionFlag === undefined ||
    !['0', 'false', 'no', 'off', 'disabled'].includes(tilionFlag.trim().toLowerCase());
  if (selected === 'tilion' && !tilionEnabled) return 'kernel';
  if (
    selected === 'kernel' ||
    selected === 'steel' ||
    selected === 'browser-use' ||
    selected === 'tilion'
  ) {
    return selected;
  }
  throw new Error(`Unsupported COMPUTE_GRANT_BROWSER_PROVIDER=${selected}`);
}

/**
 * Private key that decrypts passkey/password material.
 *
 * Passkeys are encrypted with the PAYMENT/password RSA keypair (see
 * providers/encryptionKeys), NOT the compute-credential keypair -- a different
 * key than credentialDecryptionKeyB64(). The agent worker decrypts them with
 * `config.payment.decryption_key`; the backend uses the same PAYMENT_DECRYPTION_KEY.
 */
export function passkeyDecryptionKeyB64(): string {
  const key = process.env.PAYMENT_DECRYPTION_KEY;
  if (key === undefined || key.length === 0) {
    throw new Error('PAYMENT_DECRYPTION_KEY is required to decrypt passkeys for injection');
  }
  return key;
}
