/**
 * Dev/test processes never write the production trace archive bucket.
 *
 *   production (NODE_ENV/ENVIRONMENT=production)  ─► R2 writes allowed
 *   Fly machine (FLY_APP_NAME / FLY_MACHINE_ID)    ─► allowed (cloudbench gold traces)
 *   TRACE_ARCHIVE_ALLOW_NONPROD_R2=1               ─► allowed (deliberate prod maintenance
 *                                                     scripts, e.g. backfills run locally)
 *   anything else                                  ─► R2 write/delete refused loudly;
 *                                                     a dev/test SERVER uses the local backend
 *
 * back-end/.env (and Cursor/boxes secrets) carry TRACE_ARCHIVE_BACKEND=r2, so
 * without this guard every local dev stack, benchmark and test wrote into prod.
 * Reads are unaffected: inspecting prod archives from a laptop is harmless.
 */

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
export const NONPROD_R2_OPT_IN_ENV = 'TRACE_ARCHIVE_ALLOW_NONPROD_R2';

function isProductionEnv(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.ENVIRONMENT === 'production';
}

function present(name: string): boolean {
  return (process.env[name] ?? '').trim() !== '';
}

export function r2ArchiveWritesAllowed(): boolean {
  return (
    isProductionEnv() ||
    present('FLY_APP_NAME') ||
    present('FLY_MACHINE_ID') ||
    TRUE_VALUES.has((process.env[NONPROD_R2_OPT_IN_ENV] ?? '').trim().toLowerCase())
  );
}

export class NonProductionR2WriteError extends Error {
  constructor(operation: string) {
    super(
      `Refusing to ${operation} the production trace archive (R2) from a non-production ` +
        `process. Use TRACE_ARCHIVE_BACKEND=local for dev/test, or set ` +
        `${NONPROD_R2_OPT_IN_ENV}=1 for a deliberate production maintenance script ` +
        `(e.g. backfill-code-session-checkpoints.ts).`
    );
    this.name = 'NonProductionR2WriteError';
  }
}

export function assertR2ArchiveWriteAllowed(operation = 'write'): void {
  if (!r2ArchiveWritesAllowed()) throw new NonProductionR2WriteError(operation);
}

/**
 * Server bootstrap: a dev/test backend configured for R2 archives locally
 * instead (reads and writes stay consistent). Returns true when redirected.
 */
export function redirectNonProductionServerArchiveToLocal(
  warn: (message: string) => void
): boolean {
  if ((process.env.TRACE_ARCHIVE_BACKEND ?? '').trim().toLowerCase() !== 'r2') return false;
  if (r2ArchiveWritesAllowed()) return false;
  process.env.TRACE_ARCHIVE_BACKEND = 'local';
  warn(
    `TRACE_ARCHIVE_BACKEND=r2 ignored in a non-production server; archiving locally. ` +
      `Set ${NONPROD_R2_OPT_IN_ENV}=1 to write the production bucket deliberately.`
  );
  return true;
}
