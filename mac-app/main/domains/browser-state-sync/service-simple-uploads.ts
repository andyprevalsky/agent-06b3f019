import { getErrorMessage } from '../../../shared/utils/error';
import {
  uploadCacheStoragePayload,
  uploadPasswordsPayload,
  uploadPermissionsPayload,
} from './repo';
import type { CacheStorageData, PasswordRecord, PermissionData, UploadResult } from './types';

/** Upload permission grants as a single encrypted envelope. */
export async function uploadPermissions(
  data: PermissionData,
  accessToken: string
): Promise<UploadResult> {
  if (data.grants.length === 0) {
    return { success: true };
  }

  try {
    await uploadPermissionsPayload(data, accessToken);
    console.log(`[BrowserStateSync] \u2705 Uploaded ${data.grants.length} permission grants`);
    return { success: true };
  } catch (error) {
    const message = getErrorMessage(error);
    console.error(`[BrowserStateSync] \u274c Failed to upload permissions:`, message);
    return { success: false, message };
  }
}

/** Upload cache-storage metadata (compressed) as a single envelope. */
export async function uploadCacheStorage(
  data: CacheStorageData,
  accessToken: string
): Promise<UploadResult> {
  if (data.origins.length === 0) {
    return { success: true };
  }

  try {
    await uploadCacheStoragePayload(data, accessToken);
    console.log(`[BrowserStateSync] \u2705 Uploaded ${data.origins.length} Cache Storage origins`);
    return { success: true };
  } catch (error) {
    const message = getErrorMessage(error);
    console.error(`[BrowserStateSync] \u274c Failed to upload Cache Storage:`, message);
    return { success: false, message };
  }
}

/**
 * Upload RSA-encrypted password records. Passwords are RSA-encrypted upstream,
 * this just wraps them in the transport AES envelope. No retries by design.
 */
export async function uploadPasswords(
  passwords: PasswordRecord[],
  accessToken: string
): Promise<UploadResult> {
  if (passwords.length === 0) {
    return { success: true };
  }

  try {
    await uploadPasswordsPayload({ passwords }, accessToken);
    console.log(`[BrowserStateSync] \u2705 Uploaded ${passwords.length} passwords`);
    return { success: true };
  } catch (error) {
    const message = getErrorMessage(error);
    console.error(`[BrowserStateSync] \u274c Failed to upload passwords:`, message);
    return { success: false, message };
  }
}
