/**
 * Pure write rules for IntegrationSyncProgress (no I/O, no clock reads).
 *
 *   no row ─────────────────────────────► write (new run)
 *   other runId ── retired? ──yes───────► stale(retired_run)
 *        │ no ──────────────────────────► write (new run, old id retired)
 *   same runId ── finished run? ────────► exact replay: duplicate, else stale(run_finished)
 *        │ seq lower / state rank lower ► stale(out_of_order)
 *        │ done lower in same phase ────► stale(regressed)      (non-terminal writes only)
 *        │ pct lower than stored ───────► stale(regressed)      (non-terminal writes only)
 *        │ identical content ───────────► duplicate
 *        │ syncing→syncing within 1 s ──► coalesced
 *        └──────────────────────────────► write
 *
 * Monotonic per run: done and pct never move backwards inside one run, so a late
 * or retried batch cannot rewind a bar. A writer restarts by using a new runId.
 * A terminal write (synced / failed / needs_reconnect) is a state transition: it
 * is never coalesced and never rejected for its counts, so a finished run's last
 * stored state is always terminal even when its last syncing write was coalesced.
 */

import {
  PROGRESS_MIN_WRITE_INTERVAL_MS,
  RETIRED_RUN_ID_LIMIT,
  TERMINAL_SYNC_STATES,
  type ProgressWriteInput,
  type StaleReason,
  type SyncState,
} from './syncAccountsContract';

/** The persisted, decision-relevant columns of one progress row. */
export interface ProgressFields {
  runId: string;
  retiredRunIds: string[];
  seq: number;
  state: SyncState;
  phase: string | null;
  done: bigint | null;
  total: bigint | null;
  pct: number | null;
  unit: string | null;
  etaSec: number | null;
  lastError: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  lastSyncedAt: Date | null;
}

export interface StoredProgress extends ProgressFields {
  updatedAt: Date;
}

export type ProgressDecision =
  | { kind: 'write'; fields: ProgressFields }
  | { kind: 'duplicate' }
  | { kind: 'coalesced'; retryAfterMs: number }
  | { kind: 'stale'; detail: StaleReason };

const STATE_RANK: Record<SyncState, number> = {
  idle: 0,
  syncing: 1,
  synced: 2,
  failed: 2,
  needs_reconnect: 2,
};

export function isTerminalState(state: string): boolean {
  return (TERMINAL_SYNC_STATES as readonly string[]).includes(state);
}

/** pct from counts when the total is known; a writer percent only while it is not. */
export function derivePct(
  state: SyncState,
  done: bigint | null,
  total: bigint | null,
  writerPct: number | null
): number | null {
  if (state === 'synced') return 100;
  if (total !== null) {
    if (done === null || total === 0n) return null;
    const tenths = Number((done * 1000n) / total);
    return Math.min(100, tenths / 10);
  }
  if (writerPct === null) return null;
  return Math.round(writerPct * 10) / 10;
}

function toBig(value: number | null | undefined): bigint | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : BigInt(value);
}

function pick<T>(next: T | undefined, previous: T): T {
  return next === undefined ? previous : next;
}

function startRun(
  existing: StoredProgress | null,
  input: ProgressWriteInput,
  now: Date
): ProgressFields {
  const retiredRunIds =
    existing === null
      ? []
      : [existing.runId, ...existing.retiredRunIds.filter((id) => id !== input.runId)].slice(
          0,
          RETIRED_RUN_ID_LIMIT
        );
  const terminal = isTerminalState(input.state);
  const done = toBig(input.done) ?? null;
  const total = toBig(input.total) ?? null;
  return {
    runId: input.runId,
    retiredRunIds,
    seq: input.seq ?? 0,
    state: input.state,
    phase: input.phase ?? null,
    done,
    total,
    pct: derivePct(input.state, done, total, input.pct ?? null),
    unit: input.unit ?? null,
    etaSec: terminal ? null : (input.eta_sec ?? null),
    lastError: input.error ?? null,
    startedAt: now,
    finishedAt: terminal ? now : null,
    lastSyncedAt: input.state === 'synced' ? now : (existing?.lastSyncedAt ?? null),
  };
}

function continueRun(
  existing: StoredProgress,
  input: ProgressWriteInput,
  now: Date
): ProgressFields {
  const phase = pick(input.phase, existing.phase);
  const phaseChanged = phase !== existing.phase;
  const carry = <T>(next: T | undefined, previous: T, reset: T): T =>
    next !== undefined ? next : phaseChanged ? reset : previous;
  const done = carry(toBig(input.done), existing.done, null);
  const total = carry(toBig(input.total), existing.total, null);
  const writerPct = total === null ? carry(input.pct, existing.pct, null) : null;
  const terminal = isTerminalState(input.state);
  const keepsError = input.state === 'failed' || input.state === 'needs_reconnect';
  return {
    runId: existing.runId,
    retiredRunIds: existing.retiredRunIds,
    seq: input.seq ?? existing.seq,
    state: input.state,
    phase,
    done,
    total,
    pct: derivePct(input.state, done, total, writerPct),
    unit: carry(input.unit, existing.unit, null),
    etaSec: terminal ? null : carry(input.eta_sec, existing.etaSec, null),
    lastError: input.error !== undefined ? input.error : keepsError ? existing.lastError : null,
    startedAt: existing.startedAt,
    finishedAt: terminal ? (existing.finishedAt ?? now) : null,
    lastSyncedAt: input.state === 'synced' ? now : existing.lastSyncedAt,
  };
}

function sameContent(a: ProgressFields, b: ProgressFields): boolean {
  return (
    a.state === b.state &&
    a.phase === b.phase &&
    a.done === b.done &&
    a.total === b.total &&
    a.pct === b.pct &&
    a.unit === b.unit &&
    a.etaSec === b.etaSec &&
    a.lastError === b.lastError &&
    a.seq === b.seq
  );
}

function sameRunOrder(
  existing: StoredProgress,
  input: ProgressWriteInput
): ProgressDecision | null {
  if (input.seq !== undefined && existing.seq > 0) {
    if (input.seq < existing.seq) return { kind: 'stale', detail: 'out_of_order' };
    if (input.seq === existing.seq) return { kind: 'duplicate' };
  }
  if (STATE_RANK[input.state] < STATE_RANK[existing.state]) {
    return { kind: 'stale', detail: 'out_of_order' };
  }
  if (isTerminalState(input.state)) return null;
  const phase = pick(input.phase, existing.phase);
  if (
    phase === existing.phase &&
    input.done !== undefined &&
    input.done !== null &&
    existing.done !== null &&
    BigInt(input.done) < existing.done
  ) {
    return { kind: 'stale', detail: 'regressed' };
  }
  return null;
}

export function decideProgressWrite(
  existing: StoredProgress | null,
  input: ProgressWriteInput,
  now: Date
): ProgressDecision {
  if (existing === null) return { kind: 'write', fields: startRun(null, input, now) };
  if (input.runId !== existing.runId) {
    if (existing.retiredRunIds.includes(input.runId)) {
      return { kind: 'stale', detail: 'retired_run' };
    }
    return { kind: 'write', fields: startRun(existing, input, now) };
  }

  if (isTerminalState(existing.state)) {
    // A finished run is sticky: only an exact replay of its last write is accepted.
    const replayedSeq = input.seq !== undefined && input.seq === existing.seq;
    const replay = replayedSeq || sameContent(existing, continueRun(existing, input, now));
    return replay ? { kind: 'duplicate' } : { kind: 'stale', detail: 'run_finished' };
  }
  const ordering = sameRunOrder(existing, input);
  if (ordering !== null) return ordering;

  const fields = continueRun(existing, input, now);
  if (sameContent(existing, fields)) return { kind: 'duplicate' };
  if (
    !isTerminalState(fields.state) &&
    fields.pct !== null &&
    existing.pct !== null &&
    fields.pct < existing.pct
  ) {
    return { kind: 'stale', detail: 'regressed' };
  }

  const elapsedMs = now.getTime() - existing.updatedAt.getTime();
  if (
    existing.state === 'syncing' &&
    fields.state === 'syncing' &&
    fields.phase === existing.phase &&
    elapsedMs >= 0 &&
    elapsedMs < PROGRESS_MIN_WRITE_INTERVAL_MS
  ) {
    return { kind: 'coalesced', retryAfterMs: PROGRESS_MIN_WRITE_INTERVAL_MS - elapsedMs };
  }
  return { kind: 'write', fields };
}
