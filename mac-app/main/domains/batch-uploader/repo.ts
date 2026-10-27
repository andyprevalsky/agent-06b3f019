/**
 * batch-uploader — repo layer
 *
 * Data-access boundary for the batch-uploader domain. The sole outbound
 * I/O is performed by the Uploader service (a separate provider domain)
 * via `Uploader.uploadData`; this module re-exports that call as the
 * canonical data-access function used by the service layer.
 *
 * Keeping the boundary here (rather than importing Uploader directly in
 * service.ts) preserves the forward-only layer rule and leaves a single
 * seam for test mocks if this domain ever grows its own persistence.
 */

import { Uploader } from '../../services/uploader';
import type { BrowserWindow } from 'electron';
import type { MessagingUploadOptions, UploadResult } from './types';

/**
 * Forward a batch upload request to the Uploader service. Typed args in,
 * typed result out — no logging, no orchestration, no transformation.
 */
export async function uploadBatchViaUploader(
  integrationType: string,
  data: unknown,
  accessToken: string,
  window: BrowserWindow | null,
  options: MessagingUploadOptions = {}
): Promise<UploadResult> {
  return Uploader.uploadData(integrationType, data, accessToken, window, options);
}
