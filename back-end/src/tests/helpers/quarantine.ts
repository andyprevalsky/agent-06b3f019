/**
 * In-definition test quarantine for backend tests (node:test units and blackbox domain cases).
 *
 * A quarantined test still runs. Its failure is reported, never thrown, so it cannot fail the
 * gate; its pass is reported too, so the release streak can be counted from recorded rows.
 *
 *   quarantine(meta, fn)            meta validated HERE (definition/import time): a marker without
 *        │                         a valid since/repair/error/evidence throws before any test runs
 *        ▼
 *   wrapped(...args) ──fn resolves──> QUARANTINED_PASS row + TEST_QUARANTINE stdout line
 *                    └─fn throws────> QUARANTINED_FAIL row (detail = the error) + stdout line,
 *                                     then returns normally (non-blocking)
 *
 * Unit id (the same string the runner already reports):
 *   options.unit if given, else the node:test context name (`t.name`) or the function's name;
 *   prefixed `<domain>::` inside a blackbox domain (BLACKBOX_TEST_DOMAIN set by blackbox/run.ts).
 *
 * Write the four values inline as string literals in an object literal (`quarantine({ since: …`):
 * `python3 scripts/test_quarantine.py report` finds markers and their release streak that way.
 *
 * Usage:
 *   test('name', quarantine({ since, repair, error, evidence }, async (t) => { ... }));
 *   { name: 'case', fn: quarantine(meta, async () => { ... }, { unit: 'case' }) }
 */
import {
  reportVisibleGateProgress,
  type GateProgressOptions,
  type QuarantineMeta,
} from './gateProgress';

export type { QuarantineMeta } from './gateProgress';

export interface QuarantineOptions {
  /** The case name the runner reports; required when the function is anonymous. */
  unit?: string;
  env?: Record<string, string | undefined>;
  write?: (line: string) => void;
  /** Receives the failure's full detail (default: stderr), like the Python marker. */
  writeError?: (text: string) => void;
}

const SINCE = /^(\d{4})-(\d{2})-(\d{2})$/;
// Same patterns as scripts/lib/test_quarantine.py, so a marker valid in one runner is valid in all.
const REPAIR = /^https:\/\/boxes\.dev\/thread\/[A-Za-z0-9_-]+$/;
const META_KEYS: ReadonlyArray<keyof QuarantineMeta> = ['since', 'repair', 'error', 'evidence'];

function isCalendarDate(value: string): boolean {
  const match = SINCE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Throws a QuarantineMetadataError naming every missing or invalid key. */
export class QuarantineMetadataError extends Error {
  constructor(problems: string[]) {
    super(`quarantine marker refused: ${problems.join('; ')}`);
    this.name = 'QuarantineMetadataError';
  }
}

export function validateQuarantineMeta(meta: unknown): QuarantineMeta {
  if (meta === null || typeof meta !== 'object') {
    throw new QuarantineMetadataError(['metadata must be an object']);
  }
  const record = meta as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of META_KEYS) {
    const value = record[key];
    if (typeof value !== 'string' || value.trim() === '') problems.push(`${key} is required`);
  }
  const extra = Object.keys(record).filter(
    (key) => !META_KEYS.includes(key as keyof QuarantineMeta)
  );
  if (extra.length) problems.push(`unknown key(s): ${extra.join(', ')}`);
  if (typeof record.since === 'string' && record.since && !isCalendarDate(record.since)) {
    problems.push('since must be a YYYY-MM-DD date');
  }
  if (typeof record.repair === 'string' && record.repair && !REPAIR.test(record.repair)) {
    problems.push('repair must be a boxes.dev thread URL (https://boxes.dev/thread/<id>)');
  }
  for (const key of ['error', 'evidence'] as const) {
    const value = record[key];
    if (typeof value === 'string' && /[\r\n]/.test(value)) {
      problems.push(`${key} must be one line (the verbatim first error line / one reference)`);
    }
  }
  if (problems.length) throw new QuarantineMetadataError(problems);
  return {
    since: record.since as string,
    repair: record.repair as string,
    error: (record.error as string).trim(),
    evidence: (record.evidence as string).trim(),
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

function contextName(args: unknown[]): string | undefined {
  const first = args[0];
  // node:test passes its TestContext object; a bare callback's own `.name` is never a unit.
  if (first !== null && typeof first === 'object' && 'name' in first) {
    const { name } = first as { name: unknown };
    if (typeof name === 'string' && name) return name;
  }
  return undefined;
}

export function quarantine<Args extends unknown[]>(
  meta: QuarantineMeta,
  fn: (...args: Args) => unknown,
  options: QuarantineOptions = {}
): (...args: Args) => Promise<void> {
  const checked = validateQuarantineMeta(meta);
  if (typeof fn !== 'function') throw new QuarantineMetadataError(['test function is required']);
  return async (...args: Args): Promise<void> => {
    const env = options.env ?? process.env;
    const name = options.unit ?? contextName(args) ?? fn.name;
    if (!name) {
      throw new QuarantineMetadataError([
        'unit is required for an anonymous test function (pass { unit })',
      ]);
    }
    const domain = env.BLACKBOX_TEST_DOMAIN;
    const unit = domain && !name.startsWith(`${domain}::`) ? `${domain}::${name}` : name;
    const report = (status: 'QUARANTINED_PASS' | 'QUARANTINED_FAIL', detail = ''): void => {
      const rowOptions: GateProgressOptions = { scope: 'test', detail, quarantine: checked };
      reportVisibleGateProgress(unit, status, rowOptions, env, options.write);
    };
    try {
      await fn(...args);
    } catch (error) {
      const detail = describeError(error);
      try {
        (options.writeError ?? ((text: string) => process.stderr.write(text)))(
          `quarantined test failed (non-blocking): ${unit}\n${detail}\n`
        );
      } catch {
        // A closed stderr must not turn a quarantined failure into a blocking one.
      }
      report('QUARANTINED_FAIL', detail);
      return;
    }
    report('QUARANTINED_PASS');
  };
}
