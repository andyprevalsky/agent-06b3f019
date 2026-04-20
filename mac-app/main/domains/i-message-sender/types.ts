/**
 * i-message-sender — types layer
 *
 * Shared interfaces for the AppleScript-backed iMessage bridge. Types only
 * reference external packages; no project-specific imports.
 */

/**
 * Payload for dispatching a single iMessage via the macOS Messages app.
 */
export interface IMessagePayload {
  to: string;
  message: string;
}
