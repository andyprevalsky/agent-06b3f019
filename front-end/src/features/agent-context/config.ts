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
 * Max attempts for the one-shot post-subscribe reconcile (cold-start backfill).
 * Once the channel is live the disconnected fallback poll is a no-op, so a
 * transient fetchAgentDetail failure would otherwise strand the auth-race
 * messages until an unrelated resubscribe. Retry a bounded number of times
 * while the channel remains live.
 */
export const BACKFILL_MAX_ATTEMPTS = 4;

/** Base back-off (ms) between post-subscribe backfill retries; doubles each attempt, capped at MAX_RECONNECT_DELAY_MS. */
export const BACKFILL_RETRY_BASE_MS = 500;
