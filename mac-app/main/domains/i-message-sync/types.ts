import type {
  IMessageData,
  IMessageUploadContact,
  UploadResult,
  AuthSession,
} from '../../../shared/types/ipc';
import type { NormalizedMessage, SyncEvent } from '../../services/messaging/types';

export type {
  IMessageData,
  IMessageUploadContact,
  UploadResult,
  AuthSession,
  NormalizedMessage,
  SyncEvent,
};

/** Outcome of one device-scoped batch upload (mirrors the Uploader's result). */
export interface DeviceUploadResult {
  success: boolean;
  /** The backend no longer has this Mac's account (removed by the user). */
  accountRemoved: boolean;
  message?: string;
}

/**
 * Integration record returned by IntegrationCache (one per account row).
 */
export interface Integration {
  name: string;
  /** Device account id; `''` / absent = the legacy single-account row. */
  accountId?: string;
  status: string;
  lastSyncAt?: string | null;
  config?: Record<string, unknown>;
}

/**
 * Subset of the integration config consumed by this domain.
 */
export interface IntegrationConfig {
  lastFrontendAccessAt?: string;
}

/** Why a sync started: the periodic scheduler or the user connecting iMessage. */
export type SyncTrigger = 'scheduled' | 'connect';

/** How the first upload of a run addresses this Mac's account. */
export type AccountMode = 'connect' | 'sync';

/**
 * One sync run over chat.db rows (cursorRowId, upToRowId]. Persisted after every
 * batch so a restarted sync resumes it under the same runId.
 */
export interface SyncRun {
  runId: string;
  startedAt: string;
  /** MAX(ROWID) when the run started; rows above it belong to the next run. */
  upToRowId: number;
  /** Last ROWID whose batch was stored by the backend. */
  cursorRowId: number;
  /** Rows scanned so far (never decreases within a run). */
  done: number;
  /** COUNT of message rows in (start cursor, upToRowId], counted before the run. */
  total: number;
  /** Last progress seq sent (written ahead of each send). */
  seq: number;
  /** Consecutive failed attempts at the current batch. */
  failures: number;
}

/** Local sync state of one user on this Mac. */
export interface DeviceSyncState {
  accountId: string;
  /** This Mac's account existed on the backend at least once. */
  established: boolean;
  /** The account was removed by the user; only an explicit connect recreates it. */
  removed: boolean;
  /** Every row at or below this ROWID has been uploaded. */
  lastCompletedRowId: number;
  run: SyncRun | null;
}

export interface SyncStateFile {
  version: 1;
  users: Record<string, DeviceSyncState>;
}

/** Fields of one progress write (I0 contract); runId/seq are added by the reporter. */
export interface ProgressUpdate {
  state: 'syncing' | 'synced' | 'failed';
  phase?: string;
  done?: number;
  total?: number;
  unit?: string;
  eta_sec?: number | null;
  error?: string | null;
}

/** HTTP outcome of one progress POST. */
export interface ProgressHttpResult {
  status: number;
  retryAfterMs: number | null;
  staleDetail: string | null;
}

export type DeviceSyncStatus =
  'skipped' | 'up_to_date' | 'synced' | 'interrupted' | 'failed' | 'removed';

export interface DeviceSyncOutcome {
  status: DeviceSyncStatus;
  /** Messages accepted by the backend in this invocation. */
  uploaded: number;
  done: number;
  total: number;
  /** MAX(ROWID) covered when the run finished (bumps the real-time cursor). */
  upToRowId: number | null;
  message?: string;
}
