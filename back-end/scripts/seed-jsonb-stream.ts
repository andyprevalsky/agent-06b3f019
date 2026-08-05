import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { domainFieldMatches, originDomainMatches } from './cookie-domain-scope';

export type JsonbOriginTable = 'LocalStorageOrigin' | 'IndexedDBOrigin' | 'CacheStorageOrigin';

/**
 * Every Cookie column, in schema order. The seed must reproduce the source row
 * byte for byte — measure-seed-memory.sh fingerprints `to_jsonb(row) - 'id'` on
 * both sides — so a column added to the model and not added here is silently
 * dropped user data, not a cosmetic omission.
 */
const COOKIE_COLUMNS = [
  'id',
  'userId',
  'domain',
  'name',
  'path',
  'value',
  'expiresUtc',
  'isSecure',
  'isHttpOnly',
  'browserSource',
  'syncedAt',
  'creationUtc',
  'hasExpires',
  'isPersistent',
  'lastAccessUtc',
  'lastUpdateUtc',
  'priority',
  'sameSite',
  'sourcePort',
  'sourceScheme',
  'topFrameSiteKey',
  'browserProfile',
] as const;

/** Cookie's natural identity: @@unique on the Prisma model. */
const COOKIE_IDENTITY_COLUMNS = [
  'userId',
  'domain',
  'name',
  'path',
  'topFrameSiteKey',
  'browserSource',
  'browserProfile',
] as const;

/**
 * The columns `cookieContent()` in seed-local-credentials.ts hashes, in the same
 * order. That signature is a pure passthrough over these values — no encryption,
 * no derivation — so comparing them directly in SQL is exactly the Prisma warm
 * path's "only touch rows whose content actually changed" rule.
 */
const COOKIE_CONTENT_COLUMNS = [
  'value',
  'expiresUtc',
  'isSecure',
  'isHttpOnly',
  'creationUtc',
  'hasExpires',
  'isPersistent',
  'lastAccessUtc',
  'lastUpdateUtc',
  'priority',
  'sameSite',
  'sourcePort',
  'sourceScheme',
] as const;

const PAYLOAD_COLUMN: Record<JsonbOriginTable, 'entries' | 'databases' | 'caches'> = {
  LocalStorageOrigin: 'entries',
  IndexedDBOrigin: 'databases',
  CacheStorageOrigin: 'caches',
};

const COPY_COLUMNS = '"id", "userId", "origin", PAYLOAD, "hash", "updatedAt"';
const PRISMA_ONLY_URL_PARAMETERS = [
  'connection_limit',
  'pool_timeout',
  'socket_timeout',
  'pgbouncer',
  'statement_cache_size',
  'schema',
];

/**
 * The owning memory boundary for large JSONB seed data.
 *
 * `pipeline` propagates backpressure from the target Postgres process to the
 * source Postgres process. Node therefore holds only the current pipe chunks;
 * it never constructs the canonical JSON string or lets Prisma deserialize the
 * JSONB into a multi-gigabyte object graph.
 */
export async function pipeJsonbCopy(
  source: Readable,
  target: Writable,
  options: { end?: boolean } = {}
): Promise<void> {
  // `end: false` keeps the writable open after the readable finishes so the
  // caller can decide whether a clean EOF (commit) is actually warranted.
  await pipeline(source, target, { end: options.end ?? true });
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function psqlDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  for (const parameter of PRISMA_ONLY_URL_PARAMETERS) url.searchParams.delete(parameter);
  return url.toString();
}

function quoteLikePattern(value: string, placement: 'endsWith' | 'contains'): string {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
  return quoteSqlLiteral(placement === 'endsWith' ? `%${escaped}` : `%${escaped}%`);
}

export function jsonbOriginSourceCopySql(
  table: JsonbOriginTable,
  userId: string,
  domains: string[]
): string {
  const payload = PAYLOAD_COLUMN[table];
  const matches = originDomainMatches(domains);
  const domainSql =
    matches.length === 0
      ? ''
      : ` AND (${matches
          .map(
            ({ mode, value }) =>
              `"origin" LIKE ${quoteLikePattern(value, mode)} ESCAPE ${quoteSqlLiteral('\\')}`
          )
          .join(' OR ')})`;

  return `
    COPY (
      SELECT "id", "userId", "origin", "${payload}", "hash", "updatedAt"
      FROM "${table}"
      WHERE "userId" = ${quoteSqlLiteral(userId)}${domainSql}
      ORDER BY "id" ASC
    ) TO STDOUT WITH (FORMAT csv)
  `;
}

export function jsonbOriginTargetCopySql(table: JsonbOriginTable): string {
  const payload = PAYLOAD_COLUMN[table];
  const columns = COPY_COLUMNS.replace('PAYLOAD', `"${payload}"`);
  const stage = `_Seed${table}`;

  return `
    BEGIN;
    CREATE TEMP TABLE "${stage}" (LIKE "${table}" INCLUDING DEFAULTS) ON COMMIT DROP;
    COPY "${stage}" (${columns}) FROM STDIN WITH (FORMAT csv);
    INSERT INTO "${table}" AS existing (${columns})
      SELECT ${columns} FROM "${stage}"
      ON CONFLICT ("userId", "origin") DO UPDATE SET
        "${payload}" = EXCLUDED."${payload}",
        "hash" = EXCLUDED."hash",
        "updatedAt" = EXCLUDED."updatedAt"
      WHERE existing."hash" IS DISTINCT FROM EXCLUDED."hash";
    SELECT 'SEED_STREAM_COUNT=' || count(*) FROM "${stage}";
    COMMIT;
  `;
}

function quoteColumns(columns: readonly string[]): string {
  return columns.map((column) => `"${column}"`).join(', ');
}

/**
 * Scope the cookie read to a benchmark's domains using the SAME three clauses
 * the Prisma selector emits (host cookie, domain cookie, subdomain cookie), read
 * from the shared `domainFieldMatches` description so the two paths cannot
 * diverge. The leading dot on the LIKE clause is the suffix guard:
 * "evil-doordash.com" must never be pulled into a "doordash.com" fixture.
 */
export function cookieSourceCopySql(userId: string, domains: string[]): string {
  const matches = domainFieldMatches(domains);
  const domainSql =
    matches.length === 0
      ? ''
      : ` AND (${matches
          .map(({ mode, value }) =>
            mode === 'equals'
              ? `"domain" = ${quoteSqlLiteral(value)}`
              : `"domain" LIKE ${quoteLikePattern(value, 'endsWith')} ESCAPE ${quoteSqlLiteral(
                  '\\'
                )}`
          )
          .join(' OR ')})`;

  return `
    COPY (
      SELECT ${quoteColumns(COOKIE_COLUMNS)}
      FROM "Cookie"
      WHERE "userId" = ${quoteSqlLiteral(userId)}${domainSql}
      ORDER BY "id" ASC
    ) TO STDOUT WITH (FORMAT csv)
  `;
}

/**
 * Merge the streamed cookies by their natural identity.
 *
 * `syncedAt` rides along with a content change (mirroring the Prisma upsert's
 * update payload) but is deliberately absent from the WHERE guard, so a row
 * whose only difference is its sync timestamp is left untouched — the same rows
 * the `cookieContent()` diff skips.
 */
export function cookieTargetCopySql(): string {
  const columns = quoteColumns(COOKIE_COLUMNS);
  const stage = '_SeedCookie';
  const updates = [...COOKIE_CONTENT_COLUMNS, 'syncedAt']
    .map((column) => `"${column}" = EXCLUDED."${column}"`)
    .join(',\n        ');
  const existingContent = COOKIE_CONTENT_COLUMNS.map((column) => `existing."${column}"`).join(', ');
  const incomingContent = COOKIE_CONTENT_COLUMNS.map((column) => `EXCLUDED."${column}"`).join(', ');

  return `
    BEGIN;
    CREATE TEMP TABLE "${stage}" (LIKE "Cookie" INCLUDING DEFAULTS) ON COMMIT DROP;
    COPY "${stage}" (${columns}) FROM STDIN WITH (FORMAT csv);
    INSERT INTO "Cookie" AS existing (${columns})
      SELECT ${columns} FROM "${stage}"
      ON CONFLICT (${quoteColumns(COOKIE_IDENTITY_COLUMNS)}) DO UPDATE SET
        ${updates}
      WHERE (${existingContent}) IS DISTINCT FROM (${incomingContent});
    SELECT 'SEED_STREAM_COUNT=' || count(*) FROM "${stage}";
    COMMIT;
  `;
}

type ProcessExit = { code: number | null; signal: NodeJS.Signals | null };

function waitForExit(child: ChildProcess): Promise<ProcessExit> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function captureOutput(
  stream: NodeJS.ReadableStream | null,
  maxBytes = 64 * 1024
): {
  read: () => string;
} {
  let output = '';
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk: string) => {
    output = `${output}${chunk}`.slice(-maxBytes);
  });
  return { read: () => output };
}

interface CopyStreamOptions {
  label: string;
  remoteUrl: string;
  localUrl: string;
  sourceSql: string;
  targetSql: string;
}

/**
 * Run one source-COPY → target-COPY pipe and return the streamed row count.
 *
 * Both COPY commands use CSV framing, so newlines, quotes, delimiters, and
 * arbitrarily large values retain exact Postgres semantics. Node never holds a
 * row: it only forwards pipe chunks, and `pipeline` propagates the target's
 * backpressure back to the source process.
 */
async function runCopyStream({
  label,
  remoteUrl,
  localUrl,
  sourceSql,
  targetSql,
}: CopyStreamOptions): Promise<number> {
  const commonArgs = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
  const source = spawn(
    'psql',
    [...commonArgs, '--dbname', psqlDatabaseUrl(remoteUrl), '--command', sourceSql],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const target = spawn(
    'psql',
    [...commonArgs, '--dbname', psqlDatabaseUrl(localUrl), '--command', targetSql],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );

  const sourceError = captureOutput(source.stderr);
  const targetOutput = captureOutput(target.stdout);
  const targetError = captureOutput(target.stderr);

  // Do NOT let the pipeline close the target's stdin. A source that dies partway
  // through still closes its stdout cleanly, which psql reads as a COMPLETE
  // `COPY FROM STDIN` — so the target would COMMIT the truncated page set and
  // only afterwards would we notice the source's non-zero exit. Holding stdin
  // open until the source exits 0 makes a partial stream unable to commit:
  // on failure the target is killed mid-transaction and Postgres rolls back.
  const copy = pipeJsonbCopy(source.stdout!, target.stdin!, { end: false }).then(
    () => null,
    (error: unknown) => error
  );

  const [sourceExit, copyError] = await Promise.all([waitForExit(source), copy]);

  if (sourceExit.code === 0 && copyError === null) {
    target.stdin!.end();
  } else {
    // Never a clean EOF: that is what would let a partial merge commit.
    target.kill('SIGKILL');
  }

  const targetExit = await waitForExit(target);

  if (sourceExit.code !== 0) {
    throw new Error(
      `${label} source COPY failed (${sourceExit.signal ?? `exit ${sourceExit.code}`}): ${
        sourceError.read().trim() || 'psql returned no diagnostic'
      }`
    );
  }
  if (targetExit.code !== 0) {
    throw new Error(
      `${label} target COPY failed (${targetExit.signal ?? `exit ${targetExit.code}`}): ${
        targetError.read().trim() || 'psql returned no diagnostic'
      }`
    );
  }
  if (copyError !== null) {
    throw copyError;
  }

  const match = targetOutput.read().match(/SEED_STREAM_COUNT=(\d+)/);
  if (!match) {
    throw new Error(`${label} target COPY completed without a row-count marker`);
  }
  return Number(match[1]);
}

export interface StreamJsonbOriginsOptions {
  remoteUrl: string;
  localUrl: string;
  userId: string;
  domains: string[];
  table: JsonbOriginTable;
}

/**
 * Stream one JSONB-bearing origin table directly from source Postgres into a
 * target-side temporary table, then merge it by the table's natural identity.
 *
 * The target merge preserves an existing local primary key and local-only rows,
 * matching the prior Prisma upsert behavior.
 */
export async function streamJsonbOrigins({
  remoteUrl,
  localUrl,
  userId,
  domains,
  table,
}: StreamJsonbOriginsOptions): Promise<number> {
  return runCopyStream({
    label: table,
    remoteUrl,
    localUrl,
    sourceSql: jsonbOriginSourceCopySql(table, userId, domains),
    targetSql: jsonbOriginTargetCopySql(table),
  });
}

export interface StreamCookiesOptions {
  remoteUrl: string;
  localUrl: string;
  userId: string;
  domains: string[];
}

/**
 * Stream the Cookie table Postgres-to-Postgres.
 *
 * A developer account carries ~22k cookies. Paging that through Prisma forced a
 * choice between round trips and heap: 25 rows/page needed ~880 production round
 * trips (over the deploy stack's 120s readiness contract) while 500 rows/page
 * pushed the seed's peak RSS past its ratchet. COPY removes the tradeoff — one
 * round trip, and no cookie row ever enters the V8 heap.
 */
export async function streamCookies({
  remoteUrl,
  localUrl,
  userId,
  domains,
}: StreamCookiesOptions): Promise<number> {
  return runCopyStream({
    label: 'Cookie',
    remoteUrl,
    localUrl,
    sourceSql: cookieSourceCopySql(userId, domains),
    targetSql: cookieTargetCopySql(),
  });
}
