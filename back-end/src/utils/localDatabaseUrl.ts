/**
 * One definition of "this DATABASE_URL points at a database on my machine".
 *
 * Scripts and test runners that create or delete real rows must refuse to run
 * against production. `providers/database` falls back to `back-end/.env`, whose
 * DATABASE_URL is the production Supabase pooler, so an unset DATABASE_URL is
 * just as dangerous as an explicitly remote one.
 *
 * Callers decide how to fail (throw vs. exit) and supply their own remediation
 * hint; only the local/not-local judgement lives here.
 */

/**
 * Node's `URL` keeps the brackets on IPv6 hosts
 * (`new URL('postgresql://[::1]/db').hostname === '[::1]'`) and rejects the
 * unbracketed forms outright, so a bare `::1` can never reach this set.
 */
const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Returns null when `url` is a local database, otherwise the reason it is
 * refused, phrased to be appended after "Refusing to ...: ".
 */
export function nonLocalDatabaseReason(url: string | undefined): string | null {
  if (!url) return 'DATABASE_URL is not set';

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    // Never echo the value: an unparseable URL can still hold a password.
    return 'DATABASE_URL is not a parseable URL';
  }

  return LOCAL_DATABASE_HOSTS.has(host) ? null : `database host "${host}" is not local`;
}

/** A process whose entry script lives under back-end/src/tests/. */
const TEST_ENTRYPOINT = /[\\/]src[\\/]tests[\\/]/;

/**
 * Returns the refusal for a test file that is about to query a non-local
 * database, otherwise null.
 *
 * Runners export a local DATABASE_URL, but a test file run directly
 * (`npx tsx src/tests/...`) inherits back-end/.env, which is the PRODUCTION
 * pooler, and its fixtures then write prod rows. On 2026-10-28 a direct
 * rose.blackbox.ts run upserted a prod Foundry deployment cooldown this way.
 * BACKEND_UNIT_ALLOW_REMOTE_DB=1 keeps a deliberate remote run possible.
 */
export function testEntrypointDatabaseRefusal(
  entrypoint: string | undefined,
  url: string | undefined,
  allowRemote: string | undefined
): string | null {
  if (allowRemote === '1' || !entrypoint || !TEST_ENTRYPOINT.test(entrypoint)) return null;
  const reason = nonLocalDatabaseReason(url);
  if (reason === null) return null;
  const file = entrypoint.split(/[\\/]/).pop() ?? entrypoint;
  return (
    `Refusing a database query from test file ${file}: ${reason}. Run it through its runner ` +
    '(scripts/run-blackbox-tests.sh or npm run test:unit), or point DATABASE_URL at a localhost ' +
    'database; BACKEND_UNIT_ALLOW_REMOTE_DB=1 overrides deliberately.'
  );
}
