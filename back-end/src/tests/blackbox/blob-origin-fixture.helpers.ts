import { PrismaClient } from '@prisma/client';

/**
 * The most one Postgres backend may hold while building a blob fixture. The
 * blackbox suite shares the database and the box with the other deploy gates
 * and the local stack; the nested `jsonb_build_*` builders these suites used
 * peaked at 4.4GB and were OOM-killed mid-suite, failing every domain that was
 * connected at the time.
 */
export const BLOB_FIXTURE_BACKEND_PEAK_MB = 1536;

/**
 * SQL yielding one `databases` text column: a synthetic Google Docs IndexedDB
 * value (databases[] → objectStores[] → records[] → {key, value:{key, value}})
 * with `records` entries of ~145 chars each, written in jsonb's canonical
 * output form so it round-trips byte for byte.
 *
 * Built as text by a single `string_agg`. Every `jsonb_build_*` level wrapped
 * around a large `jsonb_agg` keeps another full copy of the blob in the
 * backend until the statement ends.
 */
export function blobOriginDatabasesSql(records: number): string {
  if (!Number.isInteger(records) || records < 1) {
    throw new Error(`records must be a positive integer, got ${records}`);
  }
  return `SELECT '[{"name": "DocsErrors", "objectStores": [{"name": "Errors", "records": ['
      || string_agg(
        format(
          '{"key": "record-key-%s", "value": {"key": "record-key-%s", "value": "%s"}}',
          i, i, md5(i::text) || md5((i * 7)::text)
        ),
        ', ' ORDER BY i
      )
      || ']}]}]' AS databases
    FROM generate_series(1, ${records}) i`;
}

function singleConnectionUrl(): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.searchParams.set('connection_limit', '1');
  return url.toString();
}

/**
 * Runs `work` on a fresh single-connection client and reports the peak RSS of
 * the Postgres backend that served it. Postgres reads its own
 * `/proc/self/status`, so this needs a superuser on a Linux server: the local
 * system and Docker test databases both qualify.
 */
export async function measureBackendPeak<T>(
  work: (client: PrismaClient) => Promise<T>
): Promise<{ result: T; backendPeakMb: number }> {
  const client = new PrismaClient({ datasources: { db: { url: singleConnectionUrl() } } });
  try {
    const result = await work(client);
    const rows = await client.$queryRawUnsafe<Array<{ peak_kb: string | null }>>(
      `SELECT substring(pg_read_file('/proc/self/status') from 'VmHWM:\\s+(\\d+) kB') AS peak_kb`
    );
    const peakKb = Number(rows[0]?.peak_kb);
    if (!Number.isFinite(peakKb) || peakKb <= 0) {
      throw new Error(`could not read the Postgres backend's VmHWM (got ${rows[0]?.peak_kb})`);
    }
    return { result, backendPeakMb: Math.round(peakKb / 1024) };
  } finally {
    await client.$disconnect();
  }
}
