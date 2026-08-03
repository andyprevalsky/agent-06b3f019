/**
 * auto-updater — types layer
 *
 * Type aliases for the auto-updater domain. Re-exports the shared renderer
 * contract from shared/types/ipc and declares domain-local helpers.
 * Layer rule: this file imports nothing domain-specific — only the shared
 * IPC contract (which is provider-level) and external package types.
 */

import type { UpdateInfo, ProgressInfo } from 'electron-updater';
import type { UpdateStatusPayload } from '../../../shared/types/ipc';

export type { UpdateStatusPayload };

/**
 * Shape of the raw event args electron-updater emits that this domain
 * actually consumes. Declared explicitly so the service layer can translate
 * them into renderer-facing {@link UpdateStatusPayload}s with strict typing.
 */
export type UpdaterUpdateInfo = UpdateInfo;
export type UpdaterProgressInfo = ProgressInfo;

export type DownloadTelemetryEvent =
  | 'mac_update_download_started'
  | 'mac_update_download_progress'
  | 'mac_update_download_completed'
  | 'mac_update_download_failed';

export interface DownloadTelemetryPayload {
  event: DownloadTelemetryEvent;
  insertId: string;
  sessionId: string;
  occurredAt: string;
  version?: string;
  milestonePercent?: number;
  elapsedMs?: number;
  bytesPerSecond?: number;
  transferredBytes?: number;
  totalBytes?: number;
  errorMessage?: string;
}

export interface DownloadTelemetryPostResult {
  delivered: boolean;
  reason?: 'unauthenticated';
}
