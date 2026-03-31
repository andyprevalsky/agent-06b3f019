/**
 * SMS Webhook Domain Config
 *
 * Constants and regex patterns for SMS webhook processing.
 */

/** Regex for shortcode approval: "approve XXXXX" or "yes XXXXX" */
export const SHORTCODE_REGEX = /^(?:approve|yes)\s+([A-Z0-9]{5})$/i;
