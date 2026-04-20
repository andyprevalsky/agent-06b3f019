/**
 * messaging-core: config layer
 *
 * Constants shared across the service/repo layers. The transformer is pure and
 * only needs the Apple-epoch offset; more config arrives when/if the domain
 * grows beyond transform+stats.
 */

/**
 * Seconds between Unix epoch (1970-01-01 UTC) and Apple epoch (2001-01-01 UTC).
 * iMessage stores timestamps as nanoseconds since the Apple epoch, so the backend
 * expects the offset-adjusted nanosecond form.
 */
export const APPLE_EPOCH_OFFSET_SECONDS = 978307200;
