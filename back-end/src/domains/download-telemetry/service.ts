import { createLogger } from '../../providers/logger';
import {
  DOWNLOAD_TELEMETRY_EVENTS,
  DOWNLOAD_TELEMETRY_MAX_ERROR_LENGTH,
  DOWNLOAD_TELEMETRY_MAX_ID_LENGTH,
  DOWNLOAD_TELEMETRY_MAX_VERSION_LENGTH,
  DOWNLOAD_TELEMETRY_MILESTONES,
} from './config';
import { sendAmplitudeDownloadEvent } from './repo';
import type {
  AmplitudeDownloadEvent,
  DownloadTelemetryEvent,
  DownloadTelemetryPayload,
} from './types';

const log = createLogger('DownloadTelemetry');

export class DownloadTelemetryValidationError extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(body: Record<string, unknown>, key: string, maximumLength: number): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximumLength) {
    throw new DownloadTelemetryValidationError(`${key} must be a non-empty bounded string`);
  }
  return value;
}

function optionalString(
  body: Record<string, unknown>,
  key: string,
  maximumLength: number
): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maximumLength) {
    throw new DownloadTelemetryValidationError(`${key} must be a bounded string`);
  }
  return value;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new DownloadTelemetryValidationError(`${key} must be a finite non-negative number`);
  }
  return value;
}

function parseEvent(value: unknown): DownloadTelemetryEvent {
  if (
    typeof value !== 'string' ||
    !DOWNLOAD_TELEMETRY_EVENTS.has(value as DownloadTelemetryEvent)
  ) {
    throw new DownloadTelemetryValidationError('event is not an accepted download event');
  }
  return value as DownloadTelemetryEvent;
}

export function parseDownloadTelemetry(value: unknown): DownloadTelemetryPayload {
  if (!isObject(value)) {
    throw new DownloadTelemetryValidationError('telemetry body must be an object');
  }
  const occurredAt = requiredString(value, 'occurredAt', 40);
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new DownloadTelemetryValidationError('occurredAt must be an ISO timestamp');
  }
  const milestonePercent = optionalNumber(value, 'milestonePercent');
  if (milestonePercent !== undefined && !DOWNLOAD_TELEMETRY_MILESTONES.has(milestonePercent)) {
    throw new DownloadTelemetryValidationError('milestonePercent must be 25, 50, or 75');
  }
  return {
    event: parseEvent(value.event),
    insertId: requiredString(value, 'insertId', DOWNLOAD_TELEMETRY_MAX_ID_LENGTH),
    sessionId: requiredString(value, 'sessionId', DOWNLOAD_TELEMETRY_MAX_ID_LENGTH),
    occurredAt,
    version: optionalString(value, 'version', DOWNLOAD_TELEMETRY_MAX_VERSION_LENGTH),
    milestonePercent,
    elapsedMs: optionalNumber(value, 'elapsedMs'),
    bytesPerSecond: optionalNumber(value, 'bytesPerSecond'),
    transferredBytes: optionalNumber(value, 'transferredBytes'),
    totalBytes: optionalNumber(value, 'totalBytes'),
    errorMessage: optionalString(value, 'errorMessage', DOWNLOAD_TELEMETRY_MAX_ERROR_LENGTH),
  };
}

function eventProperties(payload: DownloadTelemetryPayload): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    source: 'mac_auto_updater',
    session_id: payload.sessionId,
  };
  const mappings: Array<[keyof DownloadTelemetryPayload, string]> = [
    ['version', 'version'],
    ['milestonePercent', 'milestone_percent'],
    ['elapsedMs', 'elapsed_ms'],
    ['bytesPerSecond', 'bytes_per_second'],
    ['transferredBytes', 'transferred_bytes'],
    ['totalBytes', 'total_bytes'],
    ['errorMessage', 'error_message'],
  ];
  for (const [inputKey, outputKey] of mappings) {
    const property = payload[inputKey];
    if (property !== undefined) properties[outputKey] = property;
  }
  return properties;
}

function amplitudeEvent(userId: string, payload: DownloadTelemetryPayload): AmplitudeDownloadEvent {
  return {
    user_id: userId,
    event_type: payload.event,
    time: Date.parse(payload.occurredAt),
    insert_id: payload.insertId,
    event_properties: eventProperties(payload),
  };
}

/** Persist the diagnostic in Render logs, then fan it out to analytics. */
export async function recordDownloadTelemetry(
  userId: string,
  payload: DownloadTelemetryPayload
): Promise<void> {
  log.info('Mac updater download telemetry', {
    event: payload.event,
    user_id: userId,
    session_id: payload.sessionId,
    insert_id: payload.insertId,
    version: payload.version,
    milestone_percent: payload.milestonePercent,
    elapsed_ms: payload.elapsedMs,
    bytes_per_second: payload.bytesPerSecond,
    transferred_bytes: payload.transferredBytes,
    total_bytes: payload.totalBytes,
    error_message: payload.errorMessage,
  });
  void sendAmplitudeDownloadEvent(amplitudeEvent(userId, payload)).catch((error: unknown) => {
    log.error('Amplitude download telemetry delivery failed', {
      event: payload.event,
      insert_id: payload.insertId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
