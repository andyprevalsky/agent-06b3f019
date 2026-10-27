/**
 * Large Fast Mode cache values live in Storage; the row keeps a small pointer.
 *
 * FastModeCacheEntry held ~50 GB of a 61 GB production database. browser_http
 * response bodies (JS bundles, JSON, images) were ~42 GB of it, with 82% of
 * those bytes in rows of 64 KB or more. Moving those bodies to the attachments
 * bucket bounds the table's growth without changing what any reader sees:
 *
 *   set:  value ≥ threshold ─► putStorageObject(sha256 path) ─► row.value = pointer
 *   get:  row.value = pointer ─► getStorageObject ─► verify sha256 ─► original value
 *         (missing or corrupt object ─► treated as a cache miss)
 *
 * Paths are content-addressed, so identical bodies (the same bundle under many
 * keys) are stored once and every write is idempotent.
 */
import { createHash } from 'node:crypto';
import { getStorageObject, putStorageObject } from './storage';
import { createLogger } from './logger';

const log = createLogger('DemoCacheOffload');

/** Kinds whose large values move to Storage. Demo/sim LLM rows stay inline. */
export const OFFLOAD_KINDS: ReadonlySet<string> = new Set(['browser_http']);
const OFFLOAD_PREFIX = 'fast-mode-cache/values/';
const OFFLOAD_MARKER = '$fastCacheOffload';
const REHYDRATE_CONCURRENCY = 8;
const REHYDRATE_TIMEOUT_MS = 10_000;

/** 82% of production browser_http bytes were in rows at or above this size. */
export const OFFLOAD_MIN_BYTES = 64 * 1024;

export interface OffloadPointer {
  path: string;
  sha256: string;
  bytes: number;
}

export function offloadPointer(value: unknown): OffloadPointer | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== OFFLOAD_MARKER) return null;
  const pointer = record[OFFLOAD_MARKER] as Partial<OffloadPointer> | null;
  if (
    !pointer ||
    typeof pointer.path !== 'string' ||
    typeof pointer.sha256 !== 'string' ||
    typeof pointer.bytes !== 'number' ||
    // Only this module's own content-addressed paths: a cached value that merely
    // has the marker shape must not read arbitrary bucket objects.
    !/^[0-9a-f]{64}$/.test(pointer.sha256) ||
    pointer.path !== `${OFFLOAD_PREFIX}${pointer.sha256}.json`
  )
    return null;
  return { path: pointer.path, sha256: pointer.sha256, bytes: pointer.bytes };
}

function sha256(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

export interface PreparedOffload {
  body: Buffer;
  pointer: OffloadPointer;
  marker: { [OFFLOAD_MARKER]: OffloadPointer };
}

/** The Storage body and row pointer for a value that should move, else null. */
export function prepareOffload(kind: string, value: unknown): PreparedOffload | null {
  if (!OFFLOAD_KINDS.has(kind) || offloadPointer(value)) return null;
  const json = JSON.stringify(value ?? null);
  const bytes = Buffer.byteLength(json);
  if (bytes < OFFLOAD_MIN_BYTES) return null;
  const digest = sha256(json);
  const pointer = { path: `${OFFLOAD_PREFIX}${digest}.json`, sha256: digest, bytes };
  return { body: Buffer.from(json), pointer, marker: { [OFFLOAD_MARKER]: pointer } };
}

/** Upload the body (idempotent: the path is its own content hash). */
export async function uploadOffload(prepared: PreparedOffload): Promise<void> {
  await putStorageObject(prepared.pointer.path, prepared.body, 'application/json');
}

/** The original value behind a pointer; `undefined` when it cannot be read back intact. */
export async function rehydrateValue(value: unknown): Promise<unknown> {
  const pointer = offloadPointer(value);
  if (!pointer) return value;
  let body: Buffer | null;
  let timer: NodeJS.Timeout | undefined;
  const controller = new AbortController();
  try {
    // A stalled download must not pin the cache read (and its single-flight waiters).
    body = await Promise.race([
      getStorageObject(pointer.path, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`timed out after ${REHYDRATE_TIMEOUT_MS} ms`));
        }, REHYDRATE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    log.warn('demo_cache.offload_read_failed', { path: pointer.path, error: String(error) });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
  if (!body || sha256(body) !== pointer.sha256) {
    log.warn('demo_cache.offload_missing_or_corrupt', { path: pointer.path, found: body !== null });
    return undefined;
  }
  return JSON.parse(body.toString('utf8')) as unknown;
}

/** Rehydrate pointer rows in place; rows whose body is unreadable are dropped (a miss). */
export async function rehydrateRows<T extends { key: string; value: unknown }>(
  rows: T[]
): Promise<T[]> {
  const result: Array<T | null> = [...rows];
  const pending = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => offloadPointer(row.value) !== null);
  for (let start = 0; start < pending.length; start += REHYDRATE_CONCURRENCY) {
    await Promise.all(
      pending.slice(start, start + REHYDRATE_CONCURRENCY).map(async ({ row, index }) => {
        const value = await rehydrateValue(row.value);
        result[index] = value === undefined ? null : { ...row, value };
      })
    );
  }
  return result.filter((row): row is T => row !== null);
}

export { sha256 as offloadSha256 };
