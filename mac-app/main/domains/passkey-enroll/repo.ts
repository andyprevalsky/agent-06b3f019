/**
 * Passkey enroll repo — upload minted passkeys to the backend.
 * Mirrors browser-state-sync's encrypted-upload contract (AES-256-CBC envelope).
 */

import { config } from '../../base/config';
import { Crypto } from '../../base/crypto';
import { PASSKEY_UPLOAD_ENDPOINT } from './config';

export interface PasskeyUploadEntry {
  rpId: string;
  credentialId: string;
  privateKey: string;
  userHandle: string | null;
  signCount: number;
  origin?: string | null;
  browserSource: string;
}

export interface PasskeyUploadPayload {
  passkeys: PasskeyUploadEntry[];
}

/** POST the passkey payload, AES-encrypted in transit, to the backend. */
export async function uploadPasskeys(
  payload: PasskeyUploadPayload,
  accessToken: string
): Promise<{ passkeyCount: number }> {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const { encrypted, iv, key } = Crypto.encrypt(body);

  const formData = new FormData();
  formData.append('data', encrypted);
  formData.append('iv', iv);
  formData.append('key', key);

  const response = await fetch(`${config.apiUrl}${PASSKEY_UPLOAD_ENDPOINT}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Passkey upload failed: ${response.status} ${errorText}`);
  }

  return (await response.json()) as { passkeyCount: number };
}
