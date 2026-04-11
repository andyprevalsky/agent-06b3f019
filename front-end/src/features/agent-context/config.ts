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
