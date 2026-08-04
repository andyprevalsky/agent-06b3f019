import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { originDomainMatches } from './cookie-domain-scope';

export type JsonbOriginTable = 'LocalStorageOrigin' | 'IndexedDBOrigin' | 'CacheStorageOrigin';

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
export async function pipeJsonbCopy(source: Readable, target: Writable): Promise<void> {
  await pipeline(source, target);
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
 * Both COPY commands use CSV framing, so newlines, quotes, delimiters, and
 * arbitrarily large JSON values retain exact Postgres JSONB semantics. The
 * target merge preserves an existing local primary key and local-only rows,
 * matching the prior Prisma upsert behavior.
 */
export async function streamJsonbOrigins({
  remoteUrl,
  localUrl,
  userId,
  domains,
  table,
}: StreamJsonbOriginsOptions): Promise<number> {
  const commonArgs = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
  const source = spawn(
    'psql',
    [
      ...commonArgs,
      '--dbname',
      psqlDatabaseUrl(remoteUrl),
      '--command',
      jsonbOriginSourceCopySql(table, userId, domains),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const target = spawn(
    'psql',
    [
      ...commonArgs,
      '--dbname',
      psqlDatabaseUrl(localUrl),
      '--command',
      jsonbOriginTargetCopySql(table),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );

  const sourceError = captureOutput(source.stderr);
  const targetOutput = captureOutput(target.stdout);
  const targetError = captureOutput(target.stderr);
  const copy = pipeJsonbCopy(source.stdout!, target.stdin!).then(
    () => null,
    (error: unknown) => error
  );

  const [sourceExit, targetExit, copyError] = await Promise.all([
    waitForExit(source),
    waitForExit(target),
    copy,
  ]);

  if (sourceExit.code !== 0) {
    throw new Error(
      `${table} source COPY failed (${sourceExit.signal ?? `exit ${sourceExit.code}`}): ${
        sourceError.read().trim() || 'psql returned no diagnostic'
      }`
    );
  }
  if (targetExit.code !== 0) {
    throw new Error(
      `${table} target COPY failed (${targetExit.signal ?? `exit ${targetExit.code}`}): ${
        targetError.read().trim() || 'psql returned no diagnostic'
      }`
    );
  }
  if (copyError !== null) {
    throw copyError;
  }

  const match = targetOutput.read().match(/SEED_STREAM_COUNT=(\d+)/);
  if (!match) {
    throw new Error(`${table} target COPY completed without a row-count marker`);
  }
  return Number(match[1]);
}
