/**
 * batch-uploader — service layer
 *
 * Business logic for the batch-uploader domain: add item-count + outcome
 * logging around the outbound upload call. The service owns the [BatchUploader]
 * log contract observed by blackbox tests and downstream consumers.
 *
 * Layer rule: service may import own repo, own types, own config, and
 * shared providers (no direct Uploader import — goes through repo).
 */

import type { BrowserWindow } from 'electron';
import { uploadBatchViaUploader } from './repo';
import type { MessagingUploadOptions, UploadResult } from './types';

const LOG_COMPONENT = 'BatchUploader';

/**
 * Upload a payload for `integrationType` via the Uploader service, logging
 * the item count before the call and success/failure after. Returns the
 * Uploader's {@link UploadResult} unchanged.
 */
export async function uploadInBatches(
  integrationType: string,
  data: unknown,
  accessToken: string,
  window: BrowserWindow | null,
  options: MessagingUploadOptions = {}
): Promise<UploadResult> {
  const itemCount = Array.isArray(data) ? data.length : 1;
  console.log(`[${LOG_COMPONENT}] 🚀 Uploading ${itemCount} item(s) for ${integrationType}`);

  const result = await uploadBatchViaUploader(integrationType, data, accessToken, window, options);

  if (!result.success) {
    console.error(`[${LOG_COMPONENT}] ❌ Upload failed for ${integrationType}:`, result.message);
  } else {
    console.log(`[${LOG_COMPONENT}] ✅ Upload complete for ${integrationType}`);
  }

  return result;
}
