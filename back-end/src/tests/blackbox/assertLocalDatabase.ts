/**
 * Refuse to run a fixture-seeding blackbox suite against a non-local database.
 *
 * scripts/run-blackbox-tests.sh already exports a localhost DATABASE_URL and
 * hard-fails when no local Postgres exists. But running a suite file directly —
 * `npx tsx src/tests/blackbox/<suite>.blackbox.ts` — skips the runner entirely
 * and dotenv then loads back-end/.env, whose DATABASE_URL points at prod
 * Supabase. Every direct `prisma.*.create` in that suite writes to production.
 *
 * That is not hypothetical: prod's Waitlist table accumulated ~2,690 rows from
 * @blackbox-test.dev / @contract-test.dev fixtures this way, which is why the
 * admin surfaces resorted to a `phone IS NOT NULL` filter and silently hid
 * every real email-only signup.
 *
 * Import this for side effect at the top of any blackbox suite that writes
 * through Prisma:
 *
 *   import './assertLocalDatabase';
 */

const ALLOW_ENV = 'BLACKBOX_TEST_ALLOW_REMOTE_DATABASE';

function isLocalDatabaseUrl(url: string): boolean {
  try {
    // The URL parser handles credentials, ports, and query strings for us.
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

export function assertLocalDatabase(databaseUrl = process.env.DATABASE_URL): void {
  if (process.env[ALLOW_ENV] === '1') return;

  const url = databaseUrl?.trim() ?? '';
  if (url === '') {
    throw new Error(
      'DATABASE_URL is not set. Blackbox suites seed fixtures through Prisma and must run ' +
        'against a local database — use `bash scripts/run-blackbox-tests.sh <domain>`.'
    );
  }
  if (!isLocalDatabaseUrl(url)) {
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return 'unparseable';
      }
    })();
    throw new Error(
      `Refusing to run a blackbox suite against non-local database host "${host}". ` +
        'These suites seed fixtures through Prisma, so this would write test rows into ' +
        'production. Run them via `bash scripts/run-blackbox-tests.sh <domain>`, which ' +
        `points DATABASE_URL at the local Postgres. Set ${ALLOW_ENV}=1 only for a ` +
        'deliberate read-only run against a remote database.'
    );
  }
}

assertLocalDatabase();
