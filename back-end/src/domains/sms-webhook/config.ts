/**
 * SMS Webhook Domain Config
 *
 * Constants for SMS webhook processing.
 */

export const SURGE_SIGNING_SECRET = process.env.SURGE_SIGNING_SECRET;
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
