/**
 * Runtime layer for fingerprint-reader.
 *
 * Exposes the static `FingerprintReader` class that existing callers
 * (IPC handler registry, browser-state-sync service, blackbox tests) already
 * import. Keeps the public surface identical to the pre-refactor flat file
 * so wiring and mocks don't need to change.
 *
 * Responsibilities: delegate `collectFingerprint` to the service layer.
 */

import * as service from './service';
import type { FingerprintData } from './types';

export type { FingerprintData } from './types';

/**
 * FingerprintReader collects browser fingerprint data from the user's system.
 * The fingerprint is based on system characteristics (hardware, GPU, screen,
 * fonts, etc.) not on the user's Chrome profile data.
 */
export class FingerprintReader {
  /**
   * Collect fingerprint data from the user's system via Chrome.
   * Uses a temporary profile since fingerprint is based on system
   * characteristics, not profile data.
   */
  static async collectFingerprint(): Promise<FingerprintData | null> {
    return service.collectFingerprint();
  }
}
