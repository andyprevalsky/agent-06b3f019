import { BrowserWindow } from 'electron';
import { config } from '../base/config';
import { Crypto } from '../base/crypto';
import type { UploadResult } from '../../shared/types/ipc';

export class Uploader {
  static async uploadData(
    integrationType: string,
    data: any,
    accessToken: string,
    window: BrowserWindow | null
  ): Promise<UploadResult> {
    try {
      // Encrypt data
      const { encrypted, iv, key } = Crypto.encrypt(data);
      
      // Prepare form data
      const formData = new FormData();
      formData.append('integrationType', integrationType);
      formData.append('data', encrypted);
      formData.append('iv', iv);
      formData.append('key', key);
      
      // Upload with progress
      window?.webContents.send('upload:progress', {
        type: integrationType,
        percent: 50,
      });
      
      const response = await fetch(`${config.apiUrl}/api/integrations/upload`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
        body: formData,
      });
      
      window?.webContents.send('upload:progress', {
        type: integrationType,
        percent: 100,
      });
      
      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }
      
      return { success: true };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

