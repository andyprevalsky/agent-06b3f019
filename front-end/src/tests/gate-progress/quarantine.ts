/**
 * In-definition test quarantine for front-end Vitest tests (same marker as the backend and
 * Python runners: since, repair, error, evidence).
 *
 * A quarantined test still runs. Its failure is reported, never thrown, so it cannot fail the
 * gate (nor trigger Vitest's deploy-gate retry); its pass is reported too, so the release
 * streak can be counted from recorded rows.
 *
 *   quarantine(meta, fn)            meta validated HERE (collection/import time): a marker
 *        │                         without a valid since/repair/error/evidence throws first
 *        ▼
 *   wrapped(context) ──fn resolves──> QUARANTINED_PASS row + TEST_QUARANTINE stdout line
 *                    └─fn throws────> QUARANTINED_FAIL row (detail = the error) + stdout line,
 *                                     then returns normally (non-blocking)
 *
 * Unit id: "<file relative to the project root> > <describe > … > title>", the same string
 * vitestReporter.ts reports, read from the Vitest test context (`context.task`).
 *
 * Write the four values inline as string literals in an object literal (`quarantine({ since: …`):
 * `python3 scripts/test_quarantine.py report` finds markers and their release streak that way.
 *
 * Usage:
 *   it('name', quarantine({ since, repair, error, evidence }, async () => { ... }));
 */
import {
  reportVisibleGateProgress,
  type GateProgressOptions,
  type QuarantineMeta,
} from './gateProgress';

export type { QuarantineMeta } from './gateProgress';

export interface QuarantineOptions {
  /** Overrides the unit read from the Vitest context. */
  unit?: string;
  env?: Record<string, string | undefined>;
  write?: (line: string) => void;
  /** Receives the failure's full detail (default: stderr), like the Python marker. */
  writeError?: (text: string) => void;
}

/** The part of Vitest's TestContext this wrapper reads (declared here, see vitestReporter.ts). */
export interface QuarantineTestContext {
  task?: { name?: string; fullTestName?: string; file?: { name?: string } };
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
    (key) => !META_KEYS.includes(key as keyof QuarantineMeta),
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

function contextUnit(context: unknown): string | undefined {
  // Vitest's test context is a function object (a legacy done() guard) carrying `task`.
  if (context === null || (typeof context !== 'object' && typeof context !== 'function')) {
    return undefined;
  }
  const task = (context as QuarantineTestContext).task;
  const title = task?.fullTestName ?? task?.name;
  if (!title) return undefined;
  return task?.file?.name ? `${task.file.name} > ${title}` : title;
}

export function quarantine<Context = QuarantineTestContext>(
  meta: QuarantineMeta,
  fn: (context: Context) => unknown,
  options: QuarantineOptions = {},
): (context: Context) => Promise<void> {
  const checked = validateQuarantineMeta(meta);
  if (typeof fn !== 'function') throw new QuarantineMetadataError(['test function is required']);
  return async (context: Context): Promise<void> => {
    const env = options.env ?? process.env;
    const unit = options.unit ?? contextUnit(context);
    if (!unit) {
      throw new QuarantineMetadataError(['unit is required outside a Vitest test (pass { unit })']);
    }
    const report = (status: 'QUARANTINED_PASS' | 'QUARANTINED_FAIL', detail = ''): void => {
      const rowOptions: GateProgressOptions = { scope: 'test', detail, quarantine: checked };
      reportVisibleGateProgress(unit, status, rowOptions, env, options.write);
    };
    try {
      await fn(context);
    } catch (error) {
      // context.skip() is a skip, not a failure: let Vitest record it as skipped.
      if ((error as { code?: unknown } | null)?.code === 'VITEST_PENDING') throw error;
      const detail = describeError(error);
      try {
        (options.writeError ?? ((text: string) => process.stderr.write(text)))(
          `quarantined test failed (non-blocking): ${unit}\n${detail}\n`,
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
