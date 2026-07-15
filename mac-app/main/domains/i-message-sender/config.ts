/**
 * i-message-sender — config layer
 *
 * Constants and AppleScript template builders for the macOS Messages app
 * bridge. Config may import from its own types layer only.
 *
 * Two AppleScript forms are used against `Messages.app`:
 *   1. Primary: resolves the recipient via `buddy "<id>" of (1st account …)`.
 *   2. Fallback: resolves via `participant "<id>" of targetService` — used
 *      when the primary lookup rejects (different Messages.app versions expose
 *      the contact through one form or the other).
 *
 * Both templates accept a pre-escaped message body — escaping is the service
 * layer's responsibility.
 */

/**
 * Name of the AppleScript interpreter binary. Exposed so the repo layer never
 * hard-codes the command.
 */
export const OSASCRIPT_BIN = 'osascript';

/** Keep both the primary and fallback attempts inside the queue's two-minute lease. */
export const OSASCRIPT_TIMEOUT_MS = 30_000;

/**
 * Validation error surfaced when `to` or `message` is empty/blank.
 */
export const MISSING_FIELDS_ERROR = 'Recipient and message are required';

/**
 * Prefix used when wrapping the final double-failure error.
 */
export const SEND_FAILURE_PREFIX = 'Failed to send iMessage';

/**
 * Build the primary AppleScript used to send an iMessage via a buddy lookup.
 * Works on macOS Monterey+ with iMessage configured.
 */
export function buildPrimaryScript(recipient: string, escapedMessage: string): string {
  return `
tell application "Messages"
  set targetBuddy to buddy "${recipient}" of (1st account whose service type is iMessage)
  send "${escapedMessage}" to targetBuddy
end tell
`;
}

/**
 * Build the fallback AppleScript used when the primary buddy lookup fails.
 * Uses the `participant … of targetService` form which works on some
 * Messages.app versions where the buddy form does not.
 */
export function buildFallbackScript(recipient: string, escapedMessage: string): string {
  return `
tell application "Messages"
  set targetService to 1st account whose service type is iMessage
  set targetBuddy to participant "${recipient}" of targetService
  send "${escapedMessage}" to targetBuddy
end tell
`;
}
