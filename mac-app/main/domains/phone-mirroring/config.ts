/**
 * Configuration for the phone-mirroring domain.
 *
 * Cadences mirror the backend contract (back-end/src/domains/phones/config.ts):
 * presence every ~20s keeps the phone online (the backend marks it offline
 * after 60s), and frames are only captured while a viewer is polling.
 */

export const LOG_COMPONENT = 'PhoneMirroring';

/** Apple's iPhone Mirroring app (macOS 15 Sequoia and later). */
export const IPHONE_MIRRORING_APP_PATH = '/System/Applications/iPhone Mirroring.app';
/** Process name reported by `pgrep -x`. */
export const IPHONE_MIRRORING_PROCESS = 'iPhone Mirroring';
/** Window title the window server reports for the mirrored phone. */
export const IPHONE_MIRRORING_WINDOW_TITLE = 'iPhone Mirroring';
/** Darwin 24 = macOS 15, the first release with iPhone Mirroring. */
export const MIN_DARWIN_MAJOR = 24;

export const PHONE_KIND = 'iphone_mirroring' as const;
export const DEFAULT_PHONE_NAME = 'iPhone';

/** Presence heartbeat cadence while idle (no viewer). */
export const PRESENCE_INTERVAL_MS = 20_000;
/** Long-poll for viewer demand between presence heartbeats. */
export const DEMAND_WAIT_MS = 20_000;
/** Back-off after a failed backend call. */
export const ERROR_BACKOFF_MS = 30_000;

/** Client-side ceilings, applied even if the backend asks for more. */
export const MAX_FPS_CEILING = 2;
export const MAX_WIDTH_CEILING = 480;
export const JPEG_QUALITY_CEILING = 80;
/** The mirrored iPhone is portrait; ask for a thumbnail this tall per px wide. */
export const THUMBNAIL_HEIGHT_RATIO = 2.2;

/** Timeout for the local probes (`pgrep`, `ioreg`, `scutil`). */
export const PROBE_TIMEOUT_MS = 3_000;
