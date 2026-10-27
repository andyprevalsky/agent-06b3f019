import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/**
 * Unit files that build their own schema and tables and drive providers that
 * take the database-wide queue-admission advisory lock
 * (`pg_advisory_xact_lock(hashtext('agent-queue-admission'))`).
 *
 * Advisory locks are scoped to a DATABASE, not a schema, so schema isolation
 * does not keep these files from blocking one another's exclusive lock (or the
 * coverage gate's blackbox backend, which shares the database while the unit
 * phase runs). Waiters then outlive Prisma's 10s interactive-transaction
 * budget and fail with P2028. Each of these files runs in a private, empty
 * database instead; they create everything they need themselves.
 */
export const ISOLATED_DATABASE_FILES: ReadonlySet<string> = new Set([
  'managed-workflow-producers-postgres.test.ts',
  'worker-deployment-queue.test.ts',
  'worker-process-recovery-postgres.test.ts',
  'workflow-queue-admission-postgres.test.ts',
]);

export interface IsolatedDatabase {
  name: string;
  /** Connection URL for the private database; keeps the base URL's query params. */
  url: string;
  drop(): void;
}

/** libpq rejects Prisma-only query parameters (connection_limit, schema, ...). */
function libpqUrl(url: URL): string {
  const plain = new URL(url.toString());
  plain.search = '';
  return plain.toString();
}

function runPsql(adminUrl: string, statement: string): void {
  execFileSync('psql', [adminUrl, '-v', 'ON_ERROR_STOP=1', '-qAtc', statement], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 30_000,
  });
}

/**
 * Create an empty database next to `baseUrl`'s and return its URL.
 * Callers must pass a URL already judged local (`nonLocalDatabaseReason`).
 */
export function createIsolatedDatabase(baseUrl: string): IsolatedDatabase {
  const base = new URL(baseUrl);
  const adminUrl = libpqUrl(base);
  const name = `unit_iso_${process.pid}_${randomBytes(4).toString('hex')}`;
  runPsql(adminUrl, `CREATE DATABASE "${name}"`);
  const isolated = new URL(base.toString());
  isolated.pathname = `/${name}`;
  return {
    name,
    url: isolated.toString(),
    drop() {
      try {
        runPsql(adminUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } catch (error) {
        process.stderr.write(
          `Could not drop isolated unit database ${name}: ${error instanceof Error ? error.message : String(error)}\n`
        );
      }
    },
  };
}
