/**
 * Runtime layer for gpt-credential-sync.
 */

import * as service from './service';
import type { SyncResult } from './types';

export class GptCredentialSync {
  static hasCredentials(): boolean {
    return service.hasCredentials();
  }

  static async syncCredentials(): Promise<SyncResult> {
    return service.syncCredentials();
  }
}
