import { MAX_FILE_SIZE, MAX_TOTAL_SIZE } from '../../providers/storage';

/** Per-file / per-call caps match the existing attachment upload limits. */
export const DISPLAY_MAX_FILE_BYTES = MAX_FILE_SIZE;
export const DISPLAY_MAX_TOTAL_BYTES = MAX_TOTAL_SIZE;

/** Server-side URL fetches: per-URL deadline and parallelism within one call. */
export const DISPLAY_URL_TIMEOUT_MS = 20_000;
export const DISPLAY_FETCH_CONCURRENCY = 4;

/** Bounds for resolving `file` names across an agent tree. */
export const DISPLAY_TREE_MAX_DEPTH = 8;
export const DISPLAY_TREE_MAX_AGENTS = 500;
