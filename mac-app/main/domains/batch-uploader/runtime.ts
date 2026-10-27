/**
 * batch-uploader — runtime layer
 *
 * Thin public entry for the batch-uploader domain. Exposes the static
 * {@link BatchUploader} class consumed by handlers/registry and by sibling
 * sync domains (browser-state-sync, i-message-sync, messaging-*) that need to
 * push a batch up to the backend's /api/integrations/* endpoints.
 *
 * Layer rule: runtime imports own service + own types only. No raw data
 * access, no inline business logic.
 */

import type { BrowserWindow } from 'electron';
import { uploadInBatches } from './service';
import type { MessagingUploadOptions, UploadResult } from './types';

/**
 * Batch upload façade. Delegates 1:1 to the service layer, which logs and
 * forwards the call through the repo to the Uploader service.
 *
 * Kept as a static class for backwards compatibility with the pre-refactor
 * call sites (`BatchUploader.uploadInBatches(...)`).
 */
export class BatchUploader {
  static async uploadInBatches(
    integrationType: string,
    data: unknown,
    accessToken: string,
    window: BrowserWindow | null,
    options: MessagingUploadOptions = {}
  ): Promise<UploadResult> {
    return uploadInBatches(integrationType, data, accessToken, window, options);
  }
}
