/**
 * integration-progress — types layer
 *
 * Wire contract for per-account sync-progress writes the Mac app sends while a
 * sync runs. Mirrors the backend `progressWriteSchema`
 * (back-end/src/domains/integrations/syncAccountsContract.ts): omitted fields
 * keep their stored value within a run.
 *
 * Layer rule: types imports nothing from the project source tree.
 */

/** Per-account sync lifecycle, matching the backend `SyncState` enum. */
export type SyncState = 'idle' | 'syncing' | 'synced' | 'failed' | 'needs_reconnect';

/** Body of POST /api/integrations/:provider/accounts/:accountId/progress. */
export interface ProgressWriteBody {
  runId: string;
  seq?: number;
  state: SyncState;
  phase?: string | null;
  done?: number | null;
  total?: number | null;
  pct?: number | null;
  unit?: string | null;
  eta_sec?: number | null;
  error?: string | null;
}

/** Outcome of one progress POST, best-effort (never throws to the caller). */
export interface ProgressPostResult {
  /** True when the server accepted the write (200) or coalesced it (202). */
  ok: boolean;
  /** HTTP status, or 0 when the request never reached the server. */
  status: number;
}

/** One browser profile's cookie total, derived from the read snapshot. */
export interface CookieProfileCount {
  /** Profile dir name (`Default`, `Profile 1`, …) or `''` for the legacy snapshot. */
  profile: string;
  total: number;
}
