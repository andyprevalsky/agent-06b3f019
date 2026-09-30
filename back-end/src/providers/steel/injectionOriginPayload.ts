import { randomUUID } from 'node:crypto';
import { prisma } from '../database';

export interface InitScriptContext {
  addInitScript(script: string): Promise<unknown>;
}

export interface OriginPayloadRef {
  id: string;
  userId: string;
  origin: string;
  hash: string;
  updatedAt: Date;
}

const COLUMNS = {
  LocalStorageOrigin: 'entries',
  IndexedDBOrigin: 'databases',
  CacheStorageOrigin: 'caches',
} as const;
type OriginTable = keyof typeof COLUMNS;
const SQL_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_ORIGIN_INIT_SCRIPT_BYTES = 1024 * 1024;

function scriptWireBytes(script: string): number {
  // JSON escaping happens again in the CDP envelope. Leave room for its IDs,
  // method, and other fixed fields, rather than budgeting the source alone.
  return Buffer.byteLength(JSON.stringify({ source: script }), 'utf8') + 1024;
}

async function readOriginTextParts(
  table: OriginTable,
  row: OriginPayloadRef,
  consume: (part: string) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  const column = COLUMNS[table];
  // Table/column come only from the closed mapping above. IDs and users are bound.
  // CacheStorage restores names only; retain that projection on the SQL side.
  const payload =
    table === 'CacheStorageOrigin'
      ? `(SELECT COALESCE(jsonb_agg(jsonb_build_object('name', item->'name')), '[]'::jsonb)
        FROM jsonb_array_elements("${column}") AS item)`
      : `"${column}"`;
  const stage = `rose_origin_${randomUUID().replaceAll('-', '')}`;
  await prisma.$transaction(
    async (tx) => {
      signal?.throwIfAborted();
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "${stage}" (payload bytea) ON COMMIT DROP`);
      // Uncompressed TOAST permits byte slices without decoding the whole blob
      // again. The transaction owns this immutable snapshot and its cleanup.
      signal?.throwIfAborted();
      await tx.$executeRawUnsafe(
        `ALTER TABLE "${stage}" ALTER COLUMN payload SET STORAGE EXTERNAL`
      );
      signal?.throwIfAborted();
      const inserted = await tx.$executeRawUnsafe(
        `INSERT INTO "${stage}" SELECT convert_to((${payload})::text, 'UTF8') FROM "${table}"
       WHERE id=$1 AND "userId"=$2 AND origin=$3 AND hash=$4 AND "updatedAt"=$5::timestamp`,
        row.id,
        row.userId,
        row.origin,
        row.hash,
        row.updatedAt
      );
      signal?.throwIfAborted();
      if (inserted !== 1) throw new Error('Origin payload disappeared during injection');
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let offset = 1;
      let total = Infinity;
      while (offset <= total) {
        signal?.throwIfAborted();
        const [part] = await tx.$queryRawUnsafe<Array<{ chunk: Uint8Array; totalLength: number }>>(
          `SELECT substring(payload FROM $3::int FOR $4::int) AS chunk,
         octet_length(payload)::int AS "totalLength" FROM "${stage}"
         WHERE EXISTS (SELECT 1 FROM "${table}" WHERE id=$1 AND "userId"=$2
           AND origin=$5 AND hash=$6 AND "updatedAt"=$7::timestamp)`,
          row.id,
          row.userId,
          offset,
          SQL_CHUNK_BYTES,
          row.origin,
          row.hash,
          row.updatedAt
        );
        signal?.throwIfAborted();
        if (!part || part.chunk.byteLength <= 0)
          throw new Error('Origin payload disappeared during injection');
        total = part.totalLength;
        // A byte boundary can divide an astral UTF-8 character. Streaming decode
        // retains its incomplete bytes until the next piece, never replacing it.
        await consume(decoder.decode(part.chunk, { stream: true }));
        offset += part.chunk.byteLength;
      }
      const tail = decoder.decode();
      if (tail) await consume(tail);
    },
    { maxWait: 15_000, timeout: 15_000 }
  );
}

function chunkScript(
  origin: string,
  token: string,
  index: number | null,
  part: string,
  total: number | null,
  apply: string
): string {
  return `(() => {
    if (window.location.origin !== ${JSON.stringify(origin)}) return;
    const key = Symbol.for(${JSON.stringify(token)});
    const state = window[key] || (window[key] = {parts: [], count: 0, total: null, done: false});
    if (state.done) return;
    const index = ${JSON.stringify(index)};
    if (index !== null && !Object.hasOwn(state.parts, index)) {
      state.parts[index] = ${JSON.stringify(part)};
      state.count++;
    }
    const total = ${JSON.stringify(total)};
    if (total !== null) state.total = total;
    if (state.total === null || state.count !== state.total) return;
    const text = state.parts.join('');
    state.parts = [];
    state.done = true;
    const data = JSON.parse(text);
    ${apply}
  })();`;
}

/** Keep blob decoding in the matching document and each CDP mutation byte-bounded. */
export async function injectOriginPayload(
  context: InitScriptContext,
  row: OriginPayloadRef | { origin: string },
  table: OriginTable,
  apply: string,
  legacyValue?: unknown,
  targetOrigin = row.origin,
  signal?: AbortSignal
): Promise<void> {
  const token = `rose.origin-state.${randomUUID()}`;
  let index = 0;
  const consume = async (raw: string) => {
    signal?.throwIfAborted();
    let offset = 0;
    while (offset < raw.length) {
      signal?.throwIfAborted();
      let end = raw.length;
      let script = chunkScript(targetOrigin, token, index, raw.slice(offset, end), null, apply);
      while (scriptWireBytes(script) > MAX_ORIGIN_INIT_SCRIPT_BYTES) {
        end = offset + Math.floor((end - offset) / 2);
        if (end <= offset) throw new Error('Origin init-script envelope exceeds its byte budget');
        script = chunkScript(targetOrigin, token, index, raw.slice(offset, end), null, apply);
      }
      await context.addInitScript(script);
      offset = end;
      index++;
    }
  };
  if ('id' in row) await readOriginTextParts(table, row, consume, signal);
  else await consume(JSON.stringify(legacyValue) ?? 'null');
  const finish = chunkScript(targetOrigin, token, null, '', index, apply);
  if (scriptWireBytes(finish) > MAX_ORIGIN_INIT_SCRIPT_BYTES) {
    throw new Error('Origin init-script envelope exceeds its byte budget');
  }
  signal?.throwIfAborted();
  await context.addInitScript(finish);
}
