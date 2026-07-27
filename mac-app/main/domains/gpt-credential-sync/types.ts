/**
 * Types for the gpt-credential-sync domain.
 */

/** Status callback used by the install/login flow to surface progress. */
export type SyncStatusCallback = (status: string) => void;

export interface SyncResult {
  success: boolean;
  message?: string;
}

export interface CodexAuthJson {
  auth_mode?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
}

export interface HybridEncryptionEnvelope {
  version: 1;
  encrypted_aes_key: string;
  iv: string;
  ciphertext: string;
}
