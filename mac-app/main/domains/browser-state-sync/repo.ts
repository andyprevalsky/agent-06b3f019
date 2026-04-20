import zlib from 'zlib';
import { promisify } from 'util';
import { config } from '../../base/config';
import { Crypto } from '../../base/crypto';
import { ENDPOINTS } from './config';

const gzip = promisify(zlib.gzip);

/**
 * Post an encrypted (optionally gzip-compressed) JSON payload to a backend
 * endpoint. Throws on non-2xx. Framework-agnostic: typed args in, void out.
 */
async function postEncryptedPayload(
  endpoint: string,
  payload: unknown,
  accessToken: string,
  options: { compress: boolean }
): Promise<void> {
  const jsonData = JSON.stringify(payload);
  let body: Buffer = Buffer.from(jsonData, 'utf8');
  if (options.compress) {
    body = await gzip(body);
  }

  const { encrypted, iv, key } = Crypto.encrypt(body);

  const formData = new FormData();
  formData.append('data', encrypted);
  formData.append('iv', iv);
  formData.append('key', key);
  if (options.compress) {
    formData.append('compressed', 'true');
  }

  const response = await fetch(`${config.apiUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Upload failed: ${response.status} ${errorText}`);
  }
}

export async function uploadLocalStorageBatch(batch: unknown, accessToken: string): Promise<void> {
  await postEncryptedPayload(ENDPOINTS.localStorage, batch, accessToken, { compress: true });
}

export async function uploadIndexedDBBatch(batch: unknown, accessToken: string): Promise<void> {
  await postEncryptedPayload(ENDPOINTS.indexedDB, batch, accessToken, { compress: true });
}

export async function uploadPermissionsPayload(
  payload: unknown,
  accessToken: string
): Promise<void> {
  await postEncryptedPayload(ENDPOINTS.permissions, payload, accessToken, { compress: false });
}

export async function uploadCacheStoragePayload(
  payload: unknown,
  accessToken: string
): Promise<void> {
  await postEncryptedPayload(ENDPOINTS.cacheStorage, payload, accessToken, { compress: true });
}

export async function uploadPasswordsPayload(payload: unknown, accessToken: string): Promise<void> {
  await postEncryptedPayload(ENDPOINTS.passwords, payload, accessToken, { compress: false });
}
