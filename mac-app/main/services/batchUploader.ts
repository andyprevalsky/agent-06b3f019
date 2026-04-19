import type { BrowserWindow } from 'electron';
import { Uploader } from './uploader';
import type { UploadResult } from '../../shared/types/ipc';

export class BatchUploader {
  static async uploadInBatches(
    integrationType: string,
    data: unknown,
    accessToken: string,
    window: BrowserWindow | null
  ): Promise<UploadResult> {
    const itemCount = Array.isArray(data) ? data.length : 1;
    console.log(`[BatchUploader] 🚀 Uploading ${itemCount} item(s) for ${integrationType}`);

    const result = await Uploader.uploadData(integrationType, data, accessToken, window);

    if (!result.success) {
      console.error(`[BatchUploader] ❌ Upload failed for ${integrationType}:`, result.message);
    } else {
      console.log(`[BatchUploader] ✅ Upload complete for ${integrationType}`);
    }

    return result;
  }
}
