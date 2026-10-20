/**
 * Phone control and screen-relay limits.
 *
 * Leases are liveness-only (C11): a holder keeps control for as long as it
 * keeps heartbeating, with no wall-clock run limit. The TTL only bounds how
 * long a dead holder can strand the phone.
 */

/** Agent lease lifetime after each acquire/heartbeat. */
export const AGENT_LEASE_TTL_MS = 30_000;
/** Agents should heartbeat at this cadence (a third of the TTL). */
export const AGENT_HEARTBEAT_INTERVAL_MS = 10_000;
/** User lease lifetime; the UI re-posts take-control while it is in control. */
export const USER_LEASE_TTL_MS = 60_000;
/** Recommended UI renew cadence for the user's lease. */
export const USER_RENEW_INTERVAL_MS = 20_000;

/** A Mac that has not heartbeated within this window reads offline. */
export const DEVICE_STALE_MS = 60_000;
/** Recommended Mac presence heartbeat cadence. */
export const DEVICE_HEARTBEAT_INTERVAL_MS = 20_000;

/** A viewer must poll a frame within this window to keep the Mac streaming. */
export const STREAM_DEMAND_TTL_MS = 8_000;
/** Frames older than this are not served (the Mac stopped or went away). */
export const FRAME_TTL_MS = 10_000;
/** Upper bounds the Mac must honour when streaming. */
export const STREAM_MAX_FPS = 2;
export const STREAM_MAX_WIDTH = 480;
export const STREAM_JPEG_QUALITY = 60;
/** Largest accepted frame; a 480px-wide JPEG at q60 is typically 30-60 KB. */
export const FRAME_MAX_BYTES = 400 * 1024;
/** Frames are held in memory for at most this many devices at once. */
export const FRAME_CACHE_MAX_DEVICES = 200;
/** Longest Mac long-poll for stream demand. */
export const STREAM_DEMAND_MAX_WAIT_MS = 25_000;

/** At most this many phones are listed per user. */
export const PHONE_LIST_LIMIT = 20;
/** Agent titles longer than this are shortened for the holder label. */
export const AGENT_TITLE_MAX_CHARS = 120;
