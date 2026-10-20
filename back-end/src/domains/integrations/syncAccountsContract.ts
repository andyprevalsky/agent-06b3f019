/**
 * Wire contract for integration sync progress (the sync-progress bar).
 *
 *   writer (Mac app batch / backend sync job, at its existing batch boundaries)
 *        │  POST /api/integrations/:provider/accounts/:accountId/progress
 *        │  or reportIntegrationProgress() in-process
 *        ▼
 *   IntegrationSyncProgress  (one row per existing Integration row:
 *                             provider = Integration.name, accountId = its accountId)
 *        │
 *        ├── GET /api/integrations            → row.accounts[] + accountsByProvider
 *        └── GET /api/integrations/progress   → {cursor, changed, accountsByProvider}
 *
 * There is no account concept beyond the existing Integration row: each row is
 * exactly one account. The storage key of the legacy row is `accountId = ''`;
 * on the wire it is spelled {@link DEFAULT_ACCOUNT_ID} so it can live in a URL.
 */

import { z } from 'zod';

/** Wire spelling of the legacy/default account (storage `accountId = ''`). */
export const DEFAULT_ACCOUNT_ID = 'default';

/** States a progress WRITER reports for one run. */
export const SYNC_STATES = ['idle', 'syncing', 'synced', 'failed', 'needs_reconnect'] as const;
export type SyncState = (typeof SYNC_STATES)[number];
export const TERMINAL_SYNC_STATES: readonly SyncState[] = ['synced', 'failed', 'needs_reconnect'];

/**
 * States an account READS as on the wire (the UI's sync bar / red dot).
 * `sync_failed` is a failed run (or a SYNC_FAILED row); `EXPIRED` is a row whose
 * legacy status is EXPIRED; `needs_reconnect` is a provider asking the user to
 * reconnect (a Google credential, or a writer reporting it).
 */
export const ACCOUNT_STATES = [
  'idle',
  'syncing',
  'synced',
  'sync_failed',
  'needs_reconnect',
  'EXPIRED',
] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

/** Units a progress bar counts in. */
export const PROGRESS_UNITS = [
  'messages',
  'chats',
  'contacts',
  'cookies',
  'passwords',
  'transactions',
  'files',
  'bytes',
  'records',
] as const;
export type ProgressUnit = (typeof PROGRESS_UNITS)[number];

/** Provider slug = Integration.name (gmail, imessage, chrome_passwords, …). */
export const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MAX_ACCOUNT_ID_LENGTH = 320;
/** Bound on progress rows one user may create (10k rule: rows scale with Integration rows). */
export const MAX_PROGRESS_ACCOUNTS_PER_USER = 200;
/** A syncing run is written at most once per this interval; transitions always write. */
export const PROGRESS_MIN_WRITE_INTERVAL_MS = 1_000;
/** How many superseded run ids are remembered to reject late writes. */
export const RETIRED_RUN_ID_LIMIT = 8;
/**
 * A run still `syncing` with no write for this long lost its writer (a crashed
 * job, a Mac that went offline before its terminal write). Its bar is not shown;
 * the account reads its Integration row's state instead, so a bar never sticks.
 */
export const PROGRESS_STALE_AFTER_MS = 15 * 60_000;

/** Progress numbers shown on a bar. Every field is null when unknown. */
export interface IntegrationAccountProgress {
  /** 0-100 (one decimal). Derived from done/total; null while indeterminate. */
  pct: number | null;
  done: number | null;
  /** null = indeterminate: the writer does not know the total. Never guessed. */
  total: number | null;
  unit: ProgressUnit | null;
  eta_sec: number | null;
  phase: string | null;
}

export interface IntegrationAccount {
  provider: string;
  /** Wire account id of the Integration row; {@link DEFAULT_ACCOUNT_ID} for `''`. */
  accountId: string;
  label: string | null;
  state: AccountState;
  /** null when no live or finished run of this row is known. */
  progress: IntegrationAccountProgress | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

export type AccountsByProvider = Record<string, IntegrationAccount[]>;

export interface ProgressDeltaResponse {
  /** Pass back as `since` on the next poll. */
  cursor: string;
  /** False when nothing an account is derived from changed after `since`. */
  changed: boolean;
  /** Every account of the user (same shape as the list), always present. */
  accountsByProvider: AccountsByProvider;
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * Body of POST /api/integrations/:provider/accounts/:accountId/progress.
 * Omitted fields keep their stored value within a run; `null` clears them.
 */
export const progressWriteSchema = z
  .object({
    runId: z.string().trim().min(1).max(128),
    /** Optional per-run write counter starting at 1; a lower value is stale, an equal one a replay. */
    seq: z.number().int().positive().max(2_147_483_647).optional(),
    state: z.enum(SYNC_STATES),
    phase: z.string().trim().min(1).max(64).nullable().optional(),
    done: count.nullable().optional(),
    total: count.nullable().optional(),
    /** Only honored while `total` is unknown (e.g. a provider that reports a percent). */
    pct: z.number().min(0).max(100).nullable().optional(),
    unit: z.enum(PROGRESS_UNITS).nullable().optional(),
    eta_sec: z.number().int().nonnegative().max(31_536_000).nullable().optional(),
    error: z.string().max(2_000).nullable().optional(),
  })
  .strict();

export type ProgressWriteInput = z.infer<typeof progressWriteSchema>;

/** What a writer gets back: the row's stored progress after its write was judged. */
export interface ProgressSnapshot {
  provider: string;
  accountId: string;
  runId: string;
  seq: number;
  state: SyncState;
  progress: IntegrationAccountProgress;
  lastSyncAt: string | null;
  lastError: string | null;
}

export type ProgressWriteOutcome =
  | { applied: true; snapshot: ProgressSnapshot }
  | { applied: false; reason: 'duplicate'; snapshot: ProgressSnapshot }
  | { applied: false; reason: 'coalesced'; retryAfterMs: number; snapshot: ProgressSnapshot }
  | { applied: false; reason: 'stale'; detail: StaleReason; snapshot: ProgressSnapshot };

export type StaleReason = 'retired_run' | 'out_of_order' | 'regressed' | 'run_finished';

export class InvalidAccountKeyError extends Error {}

export function assertProviderSlug(provider: string): void {
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new InvalidAccountKeyError(`Invalid integration provider: ${provider}`);
  }
}

/**
 * Wire (or storage) account id → storage key. `''` and {@link DEFAULT_ACCOUNT_ID}
 * both name the legacy/default row. Throws on oversized ids.
 */
export function toStorageAccountId(accountId: string): string {
  const trimmed = accountId.trim();
  if (trimmed.length > MAX_ACCOUNT_ID_LENGTH) {
    throw new InvalidAccountKeyError('Invalid integration account id');
  }
  return trimmed === DEFAULT_ACCOUNT_ID ? '' : trimmed;
}

export function toWireAccountId(storageAccountId: string): string {
  return storageAccountId === '' ? DEFAULT_ACCOUNT_ID : storageAccountId;
}
