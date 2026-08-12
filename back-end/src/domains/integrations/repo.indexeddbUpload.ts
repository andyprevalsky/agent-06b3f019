/**
 * Memory-safe IndexedDB upload ingest.
 *
 * Prod OOM 2026-08-12: JSON.parse of multi-MB `databases` blobs (and rebinding
 * them through Prisma's JSON query protocol) crash-looped Render and took login
 * down with 502s. Keep `databases` inside Postgres for the whole upsert.
 */

import { runTransactionWithRetry } from '../../providers/database';

/**
 * Ingest an IndexedDB upload JSON document without ever pulling `databases`
 * into Node. The document is bound once into a TEMP table; Postgres expands
 * origins and upserts with `e->'databases'` server-side.
 */
export async function ingestIndexedDBUploadJsonDocument(
  userId: string,
  jsonString: string
): Promise<{ batchIndex: number; totalBatches: number; originCount: number }> {
  return runTransactionWithRetry(
    async (tx) => {
      await tx.$executeRawUnsafe(`
        CREATE TEMP TABLE idb_upload_ingest_doc (
          doc jsonb NOT NULL
        ) ON COMMIT DROP
      `);
      await tx.$executeRawUnsafe(
        `INSERT INTO idb_upload_ingest_doc (doc) VALUES ($1::jsonb)`,
        jsonString
      );

      const metaRows = await tx.$queryRawUnsafe<
        Array<{
          batch_index: number | null;
          total_batches: number | null;
          origins_is_array: boolean;
        }>
      >(`
        SELECT
          (doc->>'batchIndex')::int AS batch_index,
          (doc->>'totalBatches')::int AS total_batches,
          jsonb_typeof(doc->'origins') = 'array' AS origins_is_array
        FROM idb_upload_ingest_doc
      `);

      const meta = metaRows[0];
      if (!meta?.origins_is_array) {
        throw new Error('Invalid IndexedDB payload: expected origins array');
      }

      const countRows = await tx.$queryRawUnsafe<Array<{ origin_count: number }>>(
        `
        WITH origins AS (
          SELECT
            e->>'origin' AS origin,
            e->'databases' AS databases,
            e->>'error' AS error,
            COALESCE(doc->'hashes'->> (e->>'origin'), '') AS hash
          FROM idb_upload_ingest_doc
          CROSS JOIN LATERAL jsonb_array_elements(doc->'origins') AS e
        ),
        filtered AS (
          SELECT origin, databases, hash
          FROM origins
          WHERE origin IS NOT NULL
            AND origin <> ''
            AND databases IS NOT NULL
            AND (error IS NULL OR error = '')
        ),
        upserted AS (
          INSERT INTO "IndexedDBOrigin" (id, "userId", origin, databases, hash, "updatedAt")
          SELECT gen_random_uuid(), $1, origin, databases, hash, NOW()
          FROM filtered
          ON CONFLICT ("userId", origin) DO UPDATE SET
            databases = EXCLUDED.databases,
            hash = EXCLUDED.hash,
            "updatedAt" = NOW()
          WHERE "IndexedDBOrigin".hash IS DISTINCT FROM EXCLUDED.hash
          RETURNING 1
        )
        SELECT
          (SELECT COUNT(*)::int FROM filtered) AS origin_count,
          (SELECT COUNT(*)::int FROM upserted) AS changed_count
        `,
        userId
      );

      return {
        batchIndex: meta.batch_index ?? 0,
        totalBatches: meta.total_batches ?? 1,
        originCount: countRows[0]?.origin_count ?? 0,
      };
    },
    { timeout: 120_000, maxWait: 10_000 }
  );
}
