/**
 * Memory-safe IndexedDB upload ingest.
 *
 * Prod OOM 2026-08-12: JSON.parse of multi-MB `databases` blobs (and rebinding
 * them through Prisma's JSON query protocol) crash-looped Render and took login
 * down with 502s. Keep `databases` inside Postgres for the whole upsert.
 */

import type { Prisma } from '@prisma/client';

import { runTransactionWithRetry } from '../../providers/database';
import { IndexedDBUploadPayloadInvalidError } from './types';

/** Interactive-tx ceiling: large set-based upserts, but not long enough to starve the pool. */
const INDEXEDDB_UPLOAD_TX_TIMEOUT_MS = 60_000;
const INDEXEDDB_UPLOAD_TX_MAX_WAIT_MS = 10_000;

function mapPostgresJsonClientFault(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (/invalid input syntax for type json/i.test(message)) {
    throw new IndexedDBUploadPayloadInvalidError('document is not valid JSON');
  }
  // `^-?[0-9]+$` admits values wider than a PG int (e.g. "2147483648"), so the
  // ::int cast can fail with an out-of-range error rather than a syntax error.
  // Both are malformed client payloads, not database faults.
  if (/invalid input syntax for type integer|is out of range for type integer/i.test(message)) {
    throw new IndexedDBUploadPayloadInvalidError('batchIndex/totalBatches must be integers');
  }
  throw err;
}

/**
 * Postgres text/jsonb cannot hold U+0000: a JSON `\u0000` escape fails the
 * jsonb cast with 22P05 and a raw NUL fails the text bind with 22021, which
 * 500ed every batch holding one (prod 2026-10-15..10-28). Drop NUL like the
 * cookie/localStorage uploads already do, without parsing the document (the
 * OOM guard above). Only an escape preceded by an even run of backslashes is
 * a real NUL; `\\u0000` is a literal backslash followed by text and stays.
 * The client-computed `hashes` are untouched, so skip-unchanged stays stable.
 */
export function stripNulFromJsonText(jsonText: string): string {
  if (!jsonText.includes('\\u0000') && !jsonText.includes('\u0000')) return jsonText;
  return jsonText.replaceAll('\u0000', '').replace(/(?<!\\)((?:\\\\)*)\\u0000/g, '$1');
}

interface IndexedDBUploadMeta {
  batch_index: number | null;
  total_batches: number | null;
  origins_is_array: boolean;
}

/** Bind the raw document into a TEMP table so `databases` never enters Node. */
async function bindUploadDocument(tx: Prisma.TransactionClient, jsonString: string): Promise<void> {
  await tx.$executeRawUnsafe(`
    CREATE TEMP TABLE idb_upload_ingest_doc (
      doc jsonb NOT NULL
    ) ON COMMIT DROP
  `);
  try {
    await tx.$executeRawUnsafe(
      `INSERT INTO idb_upload_ingest_doc (doc) VALUES ($1::jsonb)`,
      jsonString
    );
  } catch (err: unknown) {
    mapPostgresJsonClientFault(err);
  }
}

/** Read batch metadata server-side; never parses the document in Node. */
async function readUploadMeta(tx: Prisma.TransactionClient): Promise<IndexedDBUploadMeta> {
  let metaRows: IndexedDBUploadMeta[];
  try {
    metaRows = await tx.$queryRawUnsafe(`
      SELECT
        CASE
          WHEN doc->>'batchIndex' ~ '^-?[0-9]+$' THEN (doc->>'batchIndex')::int
          ELSE NULL
        END AS batch_index,
        CASE
          WHEN doc->>'totalBatches' ~ '^-?[0-9]+$' THEN (doc->>'totalBatches')::int
          ELSE NULL
        END AS total_batches,
        jsonb_typeof(doc->'origins') = 'array' AS origins_is_array
      FROM idb_upload_ingest_doc
    `);
  } catch (err: unknown) {
    mapPostgresJsonClientFault(err);
  }

  const meta = metaRows[0];
  if (!meta?.origins_is_array) {
    throw new IndexedDBUploadPayloadInvalidError('expected origins array');
  }
  return meta;
}

/** Expand origins and upsert entirely server-side with `e->'databases'`. */
async function upsertOrigins(tx: Prisma.TransactionClient, userId: string): Promise<number> {
  const countRows = await tx.$queryRawUnsafe<Array<{ origin_count: number }>>(
    `
    WITH origins AS (
      SELECT
        e.value->>'origin' AS origin,
        e.value->'databases' AS databases,
        e.value->>'error' AS error,
        NULLIF(doc->'hashes'->> (e.value->>'origin'), '') AS hash,
        e.ord AS ord
      FROM idb_upload_ingest_doc
      CROSS JOIN LATERAL jsonb_array_elements(doc->'origins') WITH ORDINALITY AS e(value, ord)
    ),
    filtered AS (
      -- One row per origin: duplicate origins in one payload must not abort
      -- the statement with "ON CONFLICT DO UPDATE cannot affect row a second time".
      -- DISTINCT ON keeps an arbitrary row unless ORDER BY disambiguates the tie,
      -- so order by payload position and make the policy explicit: last occurrence
      -- wins, matching "a later entry in the payload supersedes an earlier one".
      SELECT DISTINCT ON (origin) origin, databases, hash
      FROM origins
      WHERE origin IS NOT NULL
        AND origin <> ''
        AND databases IS NOT NULL
        AND (error IS NULL OR error = '')
      ORDER BY origin, ord DESC
    ),
    upserted AS (
      INSERT INTO "IndexedDBOrigin" (id, "userId", origin, databases, hash, "updatedAt")
      SELECT gen_random_uuid(), $1, origin, databases, COALESCE(hash, ''), NOW()
      FROM filtered
      ON CONFLICT ("userId", origin) DO UPDATE SET
        databases = EXCLUDED.databases,
        hash = EXCLUDED.hash,
        "updatedAt" = NOW()
      WHERE EXCLUDED.hash = ''
         OR "IndexedDBOrigin".hash IS DISTINCT FROM EXCLUDED.hash
      RETURNING 1
    )
    SELECT
      (SELECT COUNT(*)::int FROM filtered) AS origin_count,
      (SELECT COUNT(*)::int FROM upserted) AS changed_count
    `,
    userId
  );
  return countRows[0]?.origin_count ?? 0;
}

/**
 * Ingest an IndexedDB upload JSON document without ever pulling `databases`
 * into Node. The document is bound once into a TEMP table; Postgres expands
 * origins and upserts with `e->'databases'` server-side.
 *
 * Do NOT JSON.parse the document here — that is the OOM path this module exists
 * to avoid. Malformed JSON is classified from Postgres client errors instead.
 */
export async function ingestIndexedDBUploadJsonDocument(
  userId: string,
  jsonString: string
): Promise<{ batchIndex: number; totalBatches: number; originCount: number }> {
  return runTransactionWithRetry(
    async (tx) => {
      await bindUploadDocument(tx, stripNulFromJsonText(jsonString));
      const meta = await readUploadMeta(tx);
      const originCount = await upsertOrigins(tx, userId);

      return {
        batchIndex: meta.batch_index ?? 0,
        totalBatches: meta.total_batches ?? 1,
        originCount,
      };
    },
    {
      timeout: INDEXEDDB_UPLOAD_TX_TIMEOUT_MS,
      maxWait: INDEXEDDB_UPLOAD_TX_MAX_WAIT_MS,
    }
  );
}
