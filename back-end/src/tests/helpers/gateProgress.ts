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
 */
import { appendFileSync } from 'node:fs';

export const GATE_PROGRESS_ENV = 'DEPLOY_GATE_PROGRESS';
export const GATE_PROGRESS_CASE_ENV = 'DEPLOY_GATE_CASE';
export const GATE_PROGRESS_DETAIL_LIMIT = 2000;

export type GateProgressScope = 'domain' | 'suite' | 'file' | 'test';
export type GateProgressStatus = 'PASS' | 'FAIL';

export interface GateProgressRow {
  v: 1;
  scope: GateProgressScope;
  case: string;
  unit: string;
  status: GateProgressStatus;
  at: number;
  detail: string;
  log: string;
}

export interface GateProgressOptions {
  scope?: GateProgressScope;
  detail?: string;
  log?: string;
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
  return {
    v: 1,
    scope: options.scope ?? 'test',
    case: env[GATE_PROGRESS_CASE_ENV] ?? '',
    unit: String(unit),
    status,
    at: now() / 1000,
    detail: tail(String(options.detail ?? ''), GATE_PROGRESS_DETAIL_LIMIT),
    log: String(options.log ?? ''),
  };
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
  try {
    appendFileSync(target, serializeGateProgressRow(gateProgressRow(unit, status, options, env)), {
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}
