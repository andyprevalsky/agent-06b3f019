/**
 * Service layer for indexed-db-reader.
 *
 * Orchestrates the full IndexedDB scan:
 *   1. Build the argv for the bundled Python helper (`scripts/read_indexeddb.py`).
 *   2. Spawn it with the user's home directory as cwd (repo).
 *   3. Translate every failure mode — non-zero exit with stderr, non-zero
 *      exit with empty stderr (== "no matching origins"), malformed stdout,
 *      single-element `[{error}]` payload, or an outright spawn failure — into
 *      the empty `IndexedDBData` shape. The service never rejects.
 *   4. On success, compute a deterministic 16-hex sha256 prefix per non-error
 *      origin over `JSON.stringify(origin.databases)`; this is the cache key
 *      the downstream sync layer uses.
 *
 * All child-process / Electron boundaries go through repo.ts; this file is
 * pure business logic plus `crypto`.
 */

import crypto from 'crypto';
import { LOG_COMPONENT, ORIGIN_HASH_PREFIX_LENGTH, PYTHON_BIN, SCRIPT_PATH } from './config';
import { resolveHomeDir, runPythonScript } from './repo';
import type { IndexedDBData, IndexedDBOriginData } from './types';

// ---------------------------------------------------------------------------
// Per-origin change-detection hash
// ---------------------------------------------------------------------------

/**
 * Compute a stable 16-hex sha256 prefix over an origin's `databases`.
 *
 * The shape is hashed verbatim via `JSON.stringify` — callers upstream rely on
 * the fact that identical `databases` produce identical hashes across
 * invocations, and that any change (record add/remove/value tweak) flips the
 * hash. No sorting is applied: record ordering is part of the observed state.
 */
export function computeOriginHash(data: IndexedDBOriginData): string {
  const content = JSON.stringify(data.databases);
  return crypto
    .createHash('sha256')
    .update(content)
    .digest('hex')
    .slice(0, ORIGIN_HASH_PREFIX_LENGTH);
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

/** Empty `IndexedDBData` returned by every non-happy path. */
function emptyResult(): IndexedDBData {
  return { origins: [], hashes: {} };
}

/**
 * Tally every origin's `databases.length` and `objectStores[*].records.length`
 * in a single pass. Used only by the success-path summary log line.
 */
function summarizeCounts(origins: IndexedDBOriginData[]): {
  databases: number;
  records: number;
} {
  let databases = 0;
  let records = 0;
  for (const origin of origins) {
    const dbs = origin.databases ?? [];
    databases += dbs.length;
    for (const db of dbs) {
      for (const store of db.objectStores ?? []) {
        records += store.records?.length ?? 0;
      }
    }
  }
  return { databases, records };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Read IndexedDB data for origins matching the optional filter.
 * @param originFilter - Optional filter string (e.g., "amazon" to get Amazon origins)
 */
export async function readIndexedDB(originFilter?: string): Promise<IndexedDBData> {
  // With no filter, argv is `[SCRIPT_PATH]`; with one, the filter is appended
  // as arg 2. Blackbox suite asserts both shapes.
  const args = originFilter === undefined ? [SCRIPT_PATH] : [SCRIPT_PATH, originFilter];
  const filterSuffix = originFilter === undefined ? '' : ` for '${originFilter}'`;

  console.log(`[${LOG_COMPONENT}] Reading IndexedDB${filterSuffix}...`);

  const run = await runPythonScript(PYTHON_BIN, args, resolveHomeDir());

  if (run.spawnError !== null) {
    console.error(`[${LOG_COMPONENT}] Failed to spawn Python: ${String(run.spawnError)}`);
    return emptyResult();
  }

  if (run.exitCode !== 0) {
    // Exit 1 with empty stderr == "no matching origins" — not an error.
    if (run.exitCode === 1 && run.stderr.trim() === '') {
      console.log(`[${LOG_COMPONENT}] No IndexedDB data found${filterSuffix}`);
    } else {
      console.error(`[${LOG_COMPONENT}] Python script failed with code ${String(run.exitCode)}`);
      if (run.stderr.trim() !== '') {
        console.error(`[${LOG_COMPONENT}] stderr: ${run.stderr}`);
      }
    }
    return emptyResult();
  }

  return parseSuccessPayload(run.stdout);
}

/**
 * Parse a successful stdout payload into `IndexedDBData`. Malformed JSON and
 * the single-element `[{error}]` sentinel both collapse to the empty shape.
 */
function parseSuccessPayload(stdout: string): IndexedDBData {
  let results: IndexedDBOriginData[];
  try {
    results = JSON.parse(stdout) as IndexedDBOriginData[];
  } catch (error) {
    console.error(`[${LOG_COMPONENT}] Failed to parse output: ${String(error)}`);
    console.error(`[${LOG_COMPONENT}] stdout: ${stdout.slice(0, 500)}`);
    return emptyResult();
  }

  // The Python helper reports a top-level failure as a single-element
  // `[{error: "..."}]` payload — surface it and return the empty shape.
  if (results.length === 1 && results[0].error !== undefined) {
    console.error(`[${LOG_COMPONENT}] Error: ${results[0].error}`);
    return emptyResult();
  }

  const hashes: Record<string, string> = {};
  for (const origin of results) {
    if (origin.error === undefined) {
      hashes[origin.origin] = computeOriginHash(origin);
    }
  }

  const { databases, records } = summarizeCounts(results);
  console.log(
    `[${LOG_COMPONENT}] Read ${String(results.length)} origins, ` +
      `${String(databases)} databases, ${String(records)} records`
  );

  return { origins: results, hashes };
}
