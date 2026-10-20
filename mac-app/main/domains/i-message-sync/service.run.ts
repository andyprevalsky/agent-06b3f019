/**
 * i-message-sync — batched device sync with real progress.
 *
 *   gate ─► resume state.run │ or start: COUNT(rows after cursor) = total, MAX(ROWID) = upTo
 *     loop per batch (≤ SYNC_BATCH_ROWS rows, ROWID order):
 *       read ─► upload (device account; 410 = removed) ─► cursor+done saved ─► progress
 *     done ─► progress `synced` ─► cursor = upTo, run cleared
 *
 * A failed batch keeps the run (same runId) so the next sync resumes after the
 * last stored batch; `done` never moves backwards. 10k rule: per Mac, one
 * upload and at most one progress write per batch; no work across users.
 */

import { getErrorMessage } from '../../../shared/utils/error';
import { MAX_BATCH_FAILURES, PROGRESS_PHASE, PROGRESS_UNIT, SYNC_BATCH_ROWS } from './config';
import {
  checkIMessageAccess,
  countMessageRows,
  deviceAccount,
  getIMessageAccounts,
  getSession,
  invalidateIntegrations,
  loadSyncContacts,
  newRunId,
  readMessageBatch,
  sessionUserId,
  uploadDeviceBatch,
} from './repo';
import { decideGate, type Gate } from './service';
import { ProgressReporter } from './service.progress';
import {
  loadUserState,
  markAccountRemoved,
  saveUserState,
  type UserStateHandle,
} from './service.state';
import type { DeviceSyncOutcome, DeviceSyncStatus, SyncRun, SyncTrigger } from './types';

type RunGate = Extract<Gate, { kind: 'run' }>;

interface RunContext {
  handle: UserStateHandle;
  run: SyncRun;
  account: { id: string; label: string | null };
  accessToken: string;
  reporter: ProgressReporter;
  onPercent?: (percent: number) => void;
}

const MAX_ETA_SEC = 31_536_000;

function outcome(
  status: DeviceSyncStatus,
  run: SyncRun | null,
  uploaded = 0,
  message?: string
): DeviceSyncOutcome {
  return {
    status,
    uploaded,
    done: run?.done ?? 0,
    total: run?.total ?? 0,
    upToRowId: status === 'synced' && run !== null ? run.upToRowId : null,
    ...(message !== undefined && { message }),
  };
}

/** A new run over the rows after the cursor, or null when there are none. */
function startRun(handle: UserStateHandle): SyncRun | null {
  let after = handle.state.lastCompletedRowId;
  let counted = countMessageRows(after);
  if (counted.maxRowId < after) {
    // chat.db was replaced (restore / rebuild): its ROWIDs restarted.
    after = 0;
    counted = countMessageRows(0);
  }
  if (counted.total === 0) {
    handle.state.lastCompletedRowId = Math.max(after, counted.maxRowId);
    return null;
  }
  return {
    runId: newRunId(),
    startedAt: new Date().toISOString(),
    upToRowId: counted.maxRowId,
    cursorRowId: after,
    done: 0,
    total: counted.total,
    seq: 0,
    failures: 0,
  };
}

function etaSeconds(run: SyncRun, startedAtMs: number, doneAtStart: number): number | null {
  const progressed = run.done - doneAtStart;
  const elapsedSec = (Date.now() - startedAtMs) / 1000;
  if (progressed <= 0 || elapsedSec <= 0) return null;
  const eta = Math.round(((run.total - run.done) * elapsedSec) / progressed);
  return Math.min(Math.max(eta, 0), MAX_ETA_SEC);
}

async function failBatch(ctx: RunContext, message: string): Promise<DeviceSyncOutcome> {
  const { handle, run } = ctx;
  run.failures += 1;
  saveUserState(handle);
  if (run.failures < MAX_BATCH_FAILURES) {
    await ctx.reporter.report({
      state: 'syncing',
      phase: PROGRESS_PHASE,
      done: run.done,
      total: run.total,
      unit: PROGRESS_UNIT,
      error: `${message}; will retry`,
    });
    return outcome('interrupted', run, 0, message);
  }
  await ctx.reporter.report({ state: 'failed', error: message });
  handle.state.lastCompletedRowId = run.cursorRowId;
  handle.state.run = null;
  saveUserState(handle);
  return outcome('failed', run, 0, message);
}

async function uploadRun(ctx: RunContext, gate: RunGate): Promise<DeviceSyncOutcome> {
  const { handle, run } = ctx;
  const contacts = await loadSyncContacts();
  const startedAtMs = Date.now();
  const doneAtStart = run.done;
  let mode = gate.mode;
  let confirmed = gate.accountConfirmed;
  let uploaded = 0;
  while (run.cursorRowId < run.upToRowId) {
    const batch = readMessageBatch(run.cursorRowId, run.upToRowId, SYNC_BATCH_ROWS, contacts);
    if (batch.scanned === 0) break;
    if (batch.messages.length > 0) {
      const result = await uploadDeviceBatch(batch.messages, ctx.accessToken, {
        ...ctx.account,
        mode,
      });
      if (result.accountRemoved) {
        markAccountRemoved(handle);
        return outcome('removed', null, uploaded, "this Mac's iMessage account was removed");
      }
      if (!result.success) return failBatch(ctx, result.message ?? 'Upload failed');
      uploaded += batch.messages.length;
      if (mode === 'connect') invalidateIntegrations();
      mode = 'sync';
      confirmed = true;
      handle.state.established = true;
    }
    run.cursorRowId = batch.lastRowId;
    run.done = Math.min(run.total, run.done + batch.scanned);
    run.failures = 0;
    saveUserState(handle);
    ctx.onPercent?.(Math.round((run.done / run.total) * 100));
    if (confirmed && run.cursorRowId < run.upToRowId) {
      const report = await ctx.reporter.report({
        state: 'syncing',
        phase: PROGRESS_PHASE,
        done: run.done,
        total: run.total,
        unit: PROGRESS_UNIT,
        eta_sec: etaSeconds(run, startedAtMs, doneAtStart),
      });
      if (report.outcome === 'stale' && report.detail === 'retired_run') {
        // Another writer started a newer run for this account: hand over to it.
        handle.state.lastCompletedRowId = run.cursorRowId;
        handle.state.run = null;
        saveUserState(handle);
        return outcome('interrupted', run, uploaded, 'superseded by a newer sync run');
      }
    }
  }
  if (confirmed) {
    await ctx.reporter.report({
      state: 'synced',
      phase: PROGRESS_PHASE,
      done: run.done,
      total: run.total,
      unit: PROGRESS_UNIT,
    });
  }
  handle.state.lastCompletedRowId = run.upToRowId;
  handle.state.run = null;
  saveUserState(handle);
  return outcome('synced', run, uploaded);
}

/**
 * Sync this Mac's chat.db into its own iMessage account. Never throws.
 * `onPercent` receives 0-100 after every batch (the connect UI).
 */
export async function runDeviceSync(
  trigger: SyncTrigger,
  onPercent?: (percent: number) => void
): Promise<DeviceSyncOutcome> {
  const session = await getSession();
  if (!session) {
    console.log('[IMessageSync] Skipping sync - not authenticated');
    return outcome('skipped', null, 0, 'Not authenticated');
  }
  const userId = sessionUserId(session);
  if (userId === null) return outcome('skipped', null, 0, 'Not authenticated');
  if (!checkIMessageAccess()) {
    console.log('[IMessageSync] Skipping sync - no iMessage access');
    return outcome('skipped', null, 0, 'Full Disk Access required');
  }
  try {
    const account = deviceAccount();
    const handle = loadUserState(userId, account.id);
    const gate = decideGate(await getIMessageAccounts(), account.id, handle.state, trigger);
    if (gate.kind === 'skip') {
      console.log(`[IMessageSync] Skipping sync - ${gate.reason}`);
      return outcome('skipped', null, 0, gate.reason);
    }
    if (trigger === 'connect') handle.state.removed = false;
    if (gate.accountConfirmed) handle.state.established = true;
    const run = handle.state.run ?? startRun(handle);
    if (run === null) {
      saveUserState(handle);
      console.log('[IMessageSync] No new messages to sync');
      return outcome('up_to_date', null);
    }
    handle.state.run = run;
    saveUserState(handle);
    console.log(
      `[IMessageSync] Run ${run.runId}: rows ${run.cursorRowId}..${run.upToRowId}, ${run.done}/${run.total} done`
    );
    const reporter = new ProgressReporter({
      accountId: account.id,
      accessToken: session.access_token,
      runId: run.runId,
      seq: run.seq,
      persistSeq: (seq) => {
        run.seq = seq;
        saveUserState(handle);
      },
    });
    return await uploadRun(
      { handle, run, account, accessToken: session.access_token, reporter, onPercent },
      gate
    );
  } catch (error) {
    console.error('[IMessageSync] Error during sync:', error);
    return outcome('failed', null, 0, getErrorMessage(error));
  }
}
