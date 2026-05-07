/**
 * i-message-sender — service layer
 *
 * Business logic for dispatching an iMessage via AppleScript:
 *   1. Validate required fields.
 *   2. Normalize the recipient (trim surrounding whitespace).
 *   3. Escape the message body for safe AppleScript string interpolation.
 *   4. Try the primary `buddy` form first; on failure, retry with the
 *      `participant` form. If both fail, re-throw the PRIMARY error wrapped
 *      with {@link SEND_FAILURE_PREFIX} — the fallback error is dropped.
 *
 * Escape order matters: backslashes are doubled first so the subsequent
 * quote / CR / LF escapes don't have their own backslashes re-escaped.
 */

import {
  MISSING_FIELDS_ERROR,
  SEND_FAILURE_PREFIX,
  buildFallbackScript,
  buildPrimaryScript,
} from './config';
import { getErrorMessage } from '../../../shared/utils/error';
import { runOsascript } from './repo';
import type { IMessagePayload } from './types';

/**
 * Escape a message body for embedding inside an AppleScript double-quoted
 * string literal. Escape order is load-bearing — see the module docstring.
 */
function escapeForAppleScript(message: string): string {
  return message
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * Dispatch an iMessage through the macOS Messages app. See the module
 * docstring for the primary/fallback/wrap-and-throw protocol.
 */
export async function sendIMessage(payload: IMessagePayload): Promise<void> {
  const { to, message } = payload;

  if (!to || !message) {
    throw new Error(MISSING_FIELDS_ERROR);
  }

  const recipient = to.trim();
  const escapedMessage = escapeForAppleScript(message);

  const primaryScript = buildPrimaryScript(recipient, escapedMessage);

  try {
    await runOsascript(primaryScript);
  } catch (primaryError) {
    const fallbackScript = buildFallbackScript(recipient, escapedMessage);
    try {
      await runOsascript(fallbackScript);
    } catch {
      throw new Error(`${SEND_FAILURE_PREFIX}: ${getErrorMessage(primaryError)}`);
    }
  }
}
