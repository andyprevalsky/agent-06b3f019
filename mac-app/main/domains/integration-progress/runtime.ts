/**
 * integration-progress — runtime layer
 *
 * Public surface consumed by the Mac sync domains (i-message-sync,
 * messaging-whatsapp, messaging-telegram) and the blackbox tests via the
 * `main/services/integrationProgress` shim. Thin: delegates to the service layer.
 */

import { startProgressRun, type ProgressRun } from './service';
import type { ProgressPostResult, ProgressRunWrite, ProgressWriteBody } from './types';

export type { ProgressPostResult, ProgressRun, ProgressRunWrite, ProgressWriteBody };

export class IntegrationProgress {
  /** Start one best-effort progress run for a provider's Integration row. */
  static startRun(provider: string): ProgressRun {
    return startProgressRun(provider);
  }
}
