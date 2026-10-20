/** Per-file / per-call caps: the attachment upload limits (providers/storage.ts). */
export const DISPLAY_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const DISPLAY_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const DISPLAY_MAX_ITEMS = 20;
/** Pinned answers are numbered 1–9 so each one has a single-key shortcut. */
export const DISPLAY_MAX_OPTIONS = 9;

/** Server-side URL fetches: per-URL deadline and parallelism within one call. */
export const DISPLAY_URL_TIMEOUT_MS = 20_000;
export const DISPLAY_FETCH_CONCURRENCY = 4;

/** Bounds for resolving `file` names across an agent tree. */
export const DISPLAY_TREE_MAX_DEPTH = 8;
export const DISPLAY_TREE_MAX_AGENTS = 500;

/**
 * Long-poll for an answer: one GET holds at most this long, re-reading the
 * request row every poll interval, then returns `pending` so the caller polls
 * again. There is no overall deadline (plan row C11); each poll is liveness.
 */
export const REQUEST_WAIT_MAX_SECONDS = 30;
export const REQUEST_WAIT_POLL_MS = 2_000;

/** The existing approval protocol's decline sentinel (attention-requests/config). */
export const REJECTED_RESPONSE = '__REJECTED__';

/** Inline view props ride in message metadata; larger data belongs in a file. */
export const INLINE_VIEW_MAX_PROPS_BYTES = 64 * 1024;
