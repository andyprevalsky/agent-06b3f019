/**
 * auto-updater transfer telemetry
 *
 * State machine:
 * [IDLE] --begin--> [ACTIVE]
 * [ACTIVE] --progress--> emit each fixed 25/50/75 milestone at most once
 * [ACTIVE] --complete|fail--> emit terminal trace --> [IDLE]
 *
 * The fixed milestone set bounds central traffic to five posts per download:
 * start, three progress samples, and one terminal event.
 */

import { randomUUID } from 'node:crypto';
import { getErrorMessage } from '../../../shared/utils/error';
import { DOWNLOAD_TELEMETRY_MILESTONES } from './config';
import { postDownloadTelemetry } from './repo';
import type {
  DownloadTelemetryEvent,
  DownloadTelemetryPayload,
  UpdaterProgressInfo,
} from './types';

interface TransferSnapshot {
  bytesPerSecond?: number;
  transferredBytes?: number;
  totalBytes?: number;
}

interface ActiveTransfer extends TransferSnapshot {
  sessionId: string;
  startedAtMs: number;
  version?: string;
  emittedMilestones: Set<number>;
}

let activeTransfer: ActiveTransfer | null = null;
let deliveryQueue = Promise.resolve();

function elapsedMs(transfer: ActiveTransfer): number {
  return Math.max(0, Date.now() - transfer.startedAtMs);
}

function insertId(
  transfer: ActiveTransfer,
  event: DownloadTelemetryEvent,
  milestonePercent?: number
): string {
  const suffix = event === 'mac_update_download_progress' ? `progress-${milestonePercent}` : event;
  return `${transfer.sessionId}:${suffix}`;
}

function payload(
  transfer: ActiveTransfer,
  event: DownloadTelemetryEvent,
  additions: Partial<DownloadTelemetryPayload> = {}
): DownloadTelemetryPayload {
  return {
    event,
    insertId: insertId(transfer, event, additions.milestonePercent),
    sessionId: transfer.sessionId,
    occurredAt: new Date().toISOString(),
    version: transfer.version,
    elapsedMs: elapsedMs(transfer),
    bytesPerSecond: transfer.bytesPerSecond,
    transferredBytes: transfer.transferredBytes,
    totalBytes: transfer.totalBytes,
    ...additions,
  };
}

function enqueue(eventPayload: DownloadTelemetryPayload): void {
  console.log('[AutoUpdater] Download telemetry:', eventPayload);
  deliveryQueue = deliveryQueue
    .then(async () => {
      const result = await postDownloadTelemetry(eventPayload);
      if (!result.delivered) {
        console.warn('[AutoUpdater] Download telemetry not delivered:', result.reason);
      }
    })
    .catch((error: unknown) => {
      console.warn('[AutoUpdater] Download telemetry failed:', getErrorMessage(error));
    });
}

/** Start a new bounded telemetry trace for a user-initiated updater download. */
export function beginDownloadTelemetry(version: string | undefined): void {
  const transfer: ActiveTransfer = {
    sessionId: randomUUID(),
    startedAtMs: Date.now(),
    version,
    emittedMilestones: new Set<number>(),
  };
  activeTransfer = transfer;
  enqueue(payload(transfer, 'mac_update_download_started'));
}

function updateSnapshot(transfer: ActiveTransfer, progress: UpdaterProgressInfo): void {
  transfer.bytesPerSecond = progress.bytesPerSecond;
  transfer.transferredBytes = progress.transferred;
  transfer.totalBytes = progress.total;
}

/** Capture rich progress locally and send only newly crossed fixed milestones. */
export function recordDownloadProgress(progress: UpdaterProgressInfo): void {
  const transfer = activeTransfer;
  if (transfer === null) return;
  updateSnapshot(transfer, progress);
  for (const milestone of DOWNLOAD_TELEMETRY_MILESTONES) {
    if (progress.percent < milestone || transfer.emittedMilestones.has(milestone)) continue;
    transfer.emittedMilestones.add(milestone);
    enqueue(
      payload(transfer, 'mac_update_download_progress', {
        milestonePercent: milestone,
      })
    );
  }
}

/** Close the active trace after electron-updater verifies and stages the artifact. */
export function completeDownloadTelemetry(version: string): void {
  const transfer = activeTransfer;
  if (transfer === null) return;
  transfer.version = version;
  enqueue(payload(transfer, 'mac_update_download_completed'));
  activeTransfer = null;
}

/** Close the active trace with the last observed transfer snapshot and error. */
export function failDownloadTelemetry(error: unknown): void {
  const transfer = activeTransfer;
  if (transfer === null) return;
  enqueue(
    payload(transfer, 'mac_update_download_failed', {
      errorMessage: getErrorMessage(error).slice(0, 500),
    })
  );
  activeTransfer = null;
}
