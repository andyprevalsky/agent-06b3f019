/** Timeout before a completed streaming bubble is removed from state (ms). */
export const STREAM_TIMEOUT_MS = 15000;

/** Interval for checking channel health and triggering reconnect (ms). */
export const HEALTH_CHECK_INTERVAL_MS = 10000;

/** Max reconnect back-off delay (ms). */
export const MAX_RECONNECT_DELAY_MS = 30000;

/** Delay before triggering resubscribe on visibility change (ms). */
export const VISIBILITY_RECONNECT_DELAY_MS = 1000;

/** Delay before triggering resubscribe on window focus (ms). */
export const FOCUS_RECONNECT_DELAY_MS = 500;

/**
 * Poll interval (ms) for the API backfill fallback that runs while the agent's
 * realtime channel is NOT connected. Realtime is lossy (a rejected/racing
 * agent:<id> private-channel join delivers nothing and does not replay), so we
 * reconcile from the authoritative agent-detail API on this cadence until the
 * channel is live. Skipped as a no-op whenever the channel is connected.
 */
export const DISCONNECTED_BACKFILL_POLL_MS = 2000;

/**
 * The channel join right after selecting an agent is when broadcasts are most
 * often lost, and a fast first answer lands within ~0.5s. Poll on this faster
 * cadence for the first DISCONNECTED_BACKFILL_FAST_WINDOW_MS so that answer
 * surfaces without waiting for the first 2s tick.
 */
export const DISCONNECTED_BACKFILL_FAST_POLL_MS = 300;

/** Duration (ms) of the fast disconnected-backfill cadence after an agent is selected. */
export const DISCONNECTED_BACKFILL_FAST_WINDOW_MS = 3000;

/** Bound a disconnected reconcile so one hung request cannot disable all later polls. */
export const DISCONNECTED_BACKFILL_REQUEST_TIMEOUT_MS = 10000;
/** Reads of a deferred INSERT's row before its placeholder is left for the next reconcile. */
export const DEFERRED_INSERT_HYDRATION_ATTEMPTS = 3;
/** Backoff unit between those reads (attempt n waits n units). */
export const DEFERRED_INSERT_HYDRATION_RETRY_MS = 500;

/**
 * Max attempts for the one-shot post-subscribe reconcile (cold-start backfill).
 * Once the channel is live the disconnected fallback poll is a no-op, so a
 * transient fetchAgentDetail failure would otherwise strand the auth-race
 * messages until an unrelated resubscribe. Retry a bounded number of times
 * while the channel remains live.
 */
export const BACKFILL_MAX_ATTEMPTS = 4;

/** Base back-off (ms) between post-subscribe backfill retries; doubles each attempt, capped at MAX_RECONNECT_DELAY_MS. */
export const BACKFILL_RETRY_BASE_MS = 500;

/**
 * A connected realtime channel can still lose an individual broadcast. After a
 * successful subscribe, use a short burst of frequent snapshots, then reconcile
 * pending turns at the regular fallback cadence until they complete. The burst
 * is a latency optimization, not a limit on authoritative state recovery.
 */
export const CONNECTED_COMPLETION_BACKFILL_FAST_ATTEMPTS = 9;

/** Cadence for the initial connected-channel completion reconcile burst (ms). */
export const CONNECTED_COMPLETION_BACKFILL_POLL_MS = 600;

/** Finite resource budget for recovering a selected chat turn's missed broadcasts. */
export const CONNECTED_COMPLETION_BACKFILL_WINDOW_MS = 150000;
