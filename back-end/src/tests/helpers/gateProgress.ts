/**
 * Live per-unit progress rows for deploy gates (the DEPLOY_GATE_PROGRESS protocol).
 *
 * The gate worker exports DEPLOY_GATE_PROGRESS (a JSONL path) and DEPLOY_GATE_CASE (the running
 * case) to every test command. A runner appends one row per finished unit so the deploy cycle can
 * report the first failure while the gate is still running. The row matches
 * `scripts/deploy_gate_progress.py` byte for byte: same key order, compact separators, non-ASCII
 * escaped like Python's `json.dumps`, and `detail` cut to its last 2000 code points.
 *
 *   runner ──reportGateProgress──> one appendFileSync (O_APPEND, 0600) ──> progress.jsonl
 *
 * Progress is advisory: the exit code stays the verdict. With the variable unset nothing is
 * written, and a failed write is swallowed, so a broken progress file can never fail a run.
 *
 * Quarantine/flaky extension (still v1): QUARANTINED_FAIL / QUARANTINED_PASS rows carry a
 * trailing `quarantine` {since, repair, error, evidence} object and FLAKY rows a trailing
 * `attempts` count. Both keys come after `log` and are omitted on every other row, so older
 * readers and the byte-for-byte parity stay valid. Only FAIL and UNVERIFIED rows block.
 */
import { appendFileSync } from 'node:fs';

export const GATE_PROGRESS_ENV = 'DEPLOY_GATE_PROGRESS';
export const GATE_PROGRESS_CASE_ENV = 'DEPLOY_GATE_CASE';
export const GATE_PROGRESS_DETAIL_LIMIT = 2000;

export type GateProgressScope = 'domain' | 'suite' | 'file' | 'test';
export const GATE_PROGRESS_STATUSES = [
  'PASS',
  'FAIL',
  'UNVERIFIED',
  'QUARANTINED_FAIL',
  'QUARANTINED_PASS',
  'FLAKY',
] as const;
export type GateProgressStatus = (typeof GATE_PROGRESS_STATUSES)[number];
export type QuarantinedStatus = 'QUARANTINED_FAIL' | 'QUARANTINED_PASS';
export const QUARANTINE_KEYS = ['since', 'repair', 'error', 'evidence'] as const;

/** The marker metadata every runner's quarantine wrapper carries, in protocol key order. */
export interface QuarantineMeta {
  since: string;
  repair: string;
  error: string;
  evidence: string;
}

export interface GateProgressRow {
  v: 1;
  scope: GateProgressScope;
  case: string;
  unit: string;
  status: GateProgressStatus;
  at: number;
  detail: string;
  log: string;
  quarantine?: QuarantineMeta;
  attempts?: number;
}

export interface GateProgressOptions {
  scope?: GateProgressScope;
  detail?: string;
  log?: string;
  /** Written only on QUARANTINED_* rows. */
  quarantine?: QuarantineMeta;
  /** Written only on FLAKY rows: the failed run plus its passing rerun (2). */
  attempts?: number;
}

type Env = Record<string, string | undefined>;

/** The last `limit` code points, like Python's `str[-limit:]`. */
function tail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  // Two UTF-16 units per code point at most, so this window always holds `limit` code points.
  return Array.from(text.slice(-2 * limit))
    .slice(-limit)
    .join('');
}

export function gateProgressRow(
  unit: string,
  status: GateProgressStatus,
  options: GateProgressOptions = {},
  env: Env = process.env,
  now: () => number = Date.now
): GateProgressRow {
  const row: GateProgressRow = {
    v: 1,
    scope: options.scope ?? 'test',
    case: env[GATE_PROGRESS_CASE_ENV] ?? '',
    unit: String(unit),
    status,
    at: now() / 1000,
    detail: tail(String(options.detail ?? ''), GATE_PROGRESS_DETAIL_LIMIT),
    log: String(options.log ?? ''),
  };
  const { quarantine, attempts } = options;
  // Programming errors raise, like the Python row(): metadata only where the status needs it.
  if (isQuarantinedStatus(status) !== (quarantine !== undefined)) {
    throw new Error('quarantine metadata belongs on QUARANTINED_* rows only, and they require it');
  }
  if (quarantine !== undefined) {
    const values = QUARANTINE_KEYS.map((key) => quarantine[key]);
    const exact = Object.keys(quarantine).length === QUARANTINE_KEYS.length;
    if (!exact || values.some((value) => typeof value !== 'string' || value === '')) {
      throw new Error(
        `quarantine metadata needs exactly the non-empty string keys ${QUARANTINE_KEYS.join(', ')}`
      );
    }
    row.quarantine = {
      since: quarantine.since,
      repair: quarantine.repair,
      error: quarantine.error,
      evidence: quarantine.evidence,
    };
  }
  if (attempts !== undefined) {
    if (status !== 'FLAKY' || !Number.isInteger(attempts) || attempts < 2) {
      throw new Error('attempts belongs on FLAKY rows only and must be an integer >= 2');
    }
    row.attempts = attempts;
  }
  return row;
}

export function isQuarantinedStatus(status: string): status is QuarantinedStatus {
  return status === 'QUARANTINED_FAIL' || status === 'QUARANTINED_PASS';
}

/** Blocking rows only: FAIL and UNVERIFIED. Quarantined and flaky rows never block here. */
export function failures<T extends { status: string }>(rows: T[]): T[] {
  return rows.filter((row) => row.status === 'FAIL' || row.status === 'UNVERIFIED');
}

export function quarantined<T extends { status: string }>(rows: T[]): T[] {
  return rows.filter((row) => isQuarantinedStatus(row.status));
}

export function flaky<T extends { status: string }>(rows: T[]): T[] {
  return rows.filter((row) => row.status === 'FLAKY');
}

/**
 * The one stdout line a QUARANTINED_* or FLAKY row is also printed as, so log readers see it
 * without the progress file. Empty for every other status.
 */
export function gateProgressStdoutLine(row: GateProgressRow): string {
  if (isQuarantinedStatus(row.status)) {
    const meta = row.quarantine;
    return `TEST_QUARANTINE status=${row.status} unit=${row.unit} since=${meta?.since ?? ''} repair=${meta?.repair ?? ''}\n`;
  }
  if (row.status === 'FLAKY') {
    return `TEST_FLAKY unit=${row.unit} attempts=${row.attempts ?? 2} attribution=REQUIRED\n`;
  }
  return '';
}

/** One JSONL line, escaped like Python's default `ensure_ascii=True`. */
export function serializeGateProgressRow(row: GateProgressRow): string {
  const json = JSON.stringify(row).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
  return `${json}\n`;
}

/** Append one row to the gate's progress file. Returns false when unset or unwritable; never throws. */
export function reportGateProgress(
  unit: string,
  status: GateProgressStatus,
  options: GateProgressOptions = {},
  env: Env = process.env
): boolean {
  const target = env[GATE_PROGRESS_ENV];
  if (!target) return false;
  return appendGateProgressRow(target, gateProgressRow(unit, status, options, env));
}

function appendGateProgressRow(target: string, row: GateProgressRow): boolean {
  try {
    appendFileSync(target, serializeGateProgressRow(row), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Report a QUARANTINED_* or FLAKY row: print its stdout line (always, even with the progress
 * variable unset) and append the row when the gate named a progress file. Never throws.
 */
export function reportVisibleGateProgress(
  unit: string,
  status: Exclude<GateProgressStatus, 'PASS' | 'FAIL' | 'UNVERIFIED'>,
  options: GateProgressOptions = {},
  env: Env = process.env,
  write: (line: string) => void = (line) => {
    process.stdout.write(line);
  }
): boolean {
  const row = gateProgressRow(unit, status, options, env);
  try {
    write(gateProgressStdoutLine(row));
  } catch {
    // A closed stdout must not turn a reported row into a test failure.
  }
  const target = env[GATE_PROGRESS_ENV];
  return target ? appendGateProgressRow(target, row) : false;
}
