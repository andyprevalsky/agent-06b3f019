import type { DownloadTelemetryEvent } from './types';

export const AMPLITUDE_INGEST_URL =
  process.env.AMPLITUDE_INGEST_URL ?? 'https://api2.amplitude.com/2/httpapi';
export const AMPLITUDE_API_KEY = process.env.AMPLITUDE_API_KEY ?? '';

export const DOWNLOAD_TELEMETRY_EVENTS: ReadonlySet<DownloadTelemetryEvent> = new Set([
  'mac_update_download_started',
  'mac_update_download_progress',
  'mac_update_download_completed',
  'mac_update_download_failed',
]);

export const DOWNLOAD_TELEMETRY_MILESTONES: ReadonlySet<number> = new Set([25, 50, 75]);
export const DOWNLOAD_TELEMETRY_MAX_ID_LENGTH = 200;
export const DOWNLOAD_TELEMETRY_MAX_VERSION_LENGTH = 100;
export const DOWNLOAD_TELEMETRY_MAX_ERROR_LENGTH = 500;
export const DOWNLOAD_TELEMETRY_RETRY_DELAYS_MS = [200, 500] as const;
export const DOWNLOAD_TELEMETRY_TIMEOUT_MS = 5000;
