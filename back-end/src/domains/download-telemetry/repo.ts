import { retryWithBackoff } from '../../providers/retry';
import {
  AMPLITUDE_API_KEY,
  AMPLITUDE_INGEST_URL,
  DOWNLOAD_TELEMETRY_RETRY_DELAYS_MS,
  DOWNLOAD_TELEMETRY_TIMEOUT_MS,
} from './config';
import type { AmplitudeDownloadEvent } from './types';

class AmplitudeIngestError extends Error {
  constructor(
    readonly status: number,
    detail: string
  ) {
    super(`Amplitude ingestion failed (${status}): ${detail}`);
  }
}

function isRetryableAmplitudeError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof AmplitudeIngestError && (error.status === 429 || error.status >= 500))
  );
}

/** Deliver one idempotent event to Amplitude's HTTP V2 ingestion endpoint. */
export async function sendAmplitudeDownloadEvent(event: AmplitudeDownloadEvent): Promise<void> {
  const body = JSON.stringify({ api_key: AMPLITUDE_API_KEY, events: [event] });
  await retryWithBackoff(
    async () => {
      const response = await fetch(AMPLITUDE_INGEST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(DOWNLOAD_TELEMETRY_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new AmplitudeIngestError(response.status, (await response.text()).slice(0, 300));
      }
      const result = (await response.json()) as { code?: unknown };
      if (result.code !== 200) {
        throw new AmplitudeIngestError(response.status, JSON.stringify(result).slice(0, 300));
      }
    },
    {
      maxRetries: DOWNLOAD_TELEMETRY_RETRY_DELAYS_MS.length + 1,
      fixedDelays: [...DOWNLOAD_TELEMETRY_RETRY_DELAYS_MS],
      isRetryable: isRetryableAmplitudeError,
      component: 'DownloadTelemetryAmplitude',
    }
  );
}
