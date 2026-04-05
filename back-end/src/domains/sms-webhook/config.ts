/**
 * SMS Webhook Domain Config
 *
 * Constants and regex patterns for SMS webhook processing.
 */

export const SURGE_SIGNING_SECRET = process.env.SURGE_SIGNING_SECRET;
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** Regex for shortcode approval: "approve XXXXX" or "yes XXXXX" */
export const SHORTCODE_REGEX = /^(?:approve|yes)\s+([A-Z0-9]{5})$/i;
