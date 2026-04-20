/**
 * Runtime layer for permission-reader.
 *
 * Exposes the static `PermissionReader` class that existing callers
 * (browser-state-sync service, blackbox tests) already import. Keeps the
 * public surface identical to the pre-refactor flat file so wiring and
 * `vi.mock` seams don't need to change.
 *
 * Responsibility: delegate `readPermissions` to the service layer.
 */

import * as service from './service';
import type { PermissionData } from './types';

export type { PermissionData, PermissionGrant } from './types';

export class PermissionReader {
  /**
   * Read permission grants from Chrome's Preferences file.
   * Returns grants with allow (1) or block (2) settings.
   */
  static async readPermissions(): Promise<PermissionData> {
    return service.readPermissions();
  }
}
