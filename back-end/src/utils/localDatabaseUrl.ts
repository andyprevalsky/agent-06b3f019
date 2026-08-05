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
    return `DATABASE_URL is not a parseable URL: ${url}`;
  }

  return LOCAL_DATABASE_HOSTS.has(host) ? null : `database host "${host}" is not local`;
}
