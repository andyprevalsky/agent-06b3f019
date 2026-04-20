/**
 * Types for the claude-credential-sync domain.
 *
 * Encapsulates the shapes for the Keychain credential envelope, the RSA+AES
 * hybrid-encryption payload sent to the backend, and the sync result.
 */

/** Status callback used by the install/OAuth flow to surface progress. */
export type SyncStatusCallback = (status: string) => void;

/** Result shape returned by `syncCredentials`. */
export interface SyncResult {
  success: boolean;
  message?: string;
}

/**
 * JSON payload written to the macOS Keychain by `claude setup-token`.
 * Only the fields we actually read here are modeled.
 */
export interface ClaudeCredentialsJson {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
  };
}

/**
 * RSA-2048 + AES-256-GCM hybrid-encryption envelope format (v1).
 * Serialized as JSON, then base64-encoded for transport.
 */
export interface HybridEncryptionEnvelope {
  version: 1;
  encrypted_aes_key: string;
  iv: string;
  ciphertext: string;
}
