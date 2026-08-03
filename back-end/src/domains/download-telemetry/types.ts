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

export interface AmplitudeDownloadEvent {
  user_id: string;
  event_type: DownloadTelemetryEvent;
  time: number;
  insert_id: string;
  event_properties: Record<string, unknown>;
}
