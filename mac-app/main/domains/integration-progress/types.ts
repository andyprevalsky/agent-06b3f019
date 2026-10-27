/**
 * integration-progress — types layer
 *
 * Wire contract for the sync-progress writes the Mac app sends while a sync
 * runs. Mirrors the backend `progressWriteSchema`
 * (back-end/src/domains/integrations/syncAccountsContract.ts): omitted fields
 * keep their stored value within a run.
 *
 * Layer rule: types imports nothing from the project source tree.
 */

/** Run lifecycle a writer reports, matching the backend writer `SyncState`. */
export type SyncState = 'idle' | 'syncing' | 'synced' | 'failed' | 'needs_reconnect';

/** Units the backend accepts for a progress bar. */
export type ProgressUnit =
  | 'messages'
  | 'chats'
  | 'contacts'
  | 'cookies'
  | 'passwords'
  | 'transactions'
  | 'files'
  | 'bytes'
  | 'records';

/** Body of POST /api/integrations/:provider/accounts/:accountId/progress. */
export interface ProgressWriteBody {
  runId: string;
  seq?: number;
  state: SyncState;
  phase?: string | null;
  done?: number | null;
  total?: number | null;
  pct?: number | null;
  unit?: ProgressUnit | null;
  eta_sec?: number | null;
  error?: string | null;
}

/** One write of a run (the run supplies `runId` and `seq`). */
export type ProgressRunWrite = Omit<ProgressWriteBody, 'runId' | 'seq'>;

/** Outcome of one progress POST, best-effort (never throws to the caller). */
export interface ProgressPostResult {
  /** True when the server accepted the write (200) or coalesced it (202). */
  ok: boolean;
  /** HTTP status, or 0 when the request never reached the server. */
  status: number;
}
