/**
 * IPC surface for the launcher feature.
 *
 * The launcher has no HTTP boundary — it talks only to the Electron main
 * process via `window.api.*` (see `shared/types/ipc.ts`). This file is the
 * SOLE consumer of `window.api.*` within the feature so the blackbox IPC-
 * mock harness can drive the same seams in tests.
 *
 * No UI rendering, no business logic beyond "get bytes in / get bytes out".
 */

import type {
  QuickQueryToggleState,
  QuickQueryPayload,
  QuickQueryResizePayload,
} from '../../../shared/types/ipc';

/**
 * Subscribe to Quick-Query toggle events from the main process.
 *
 * The main process fires these whenever the global shortcut opens or
 * closes the launcher window. Consumers use the `{ open: true }` case to
 * reset UI state and focus the input.
 */
export const onQuickQueryToggle = (callback: (state: QuickQueryToggleState) => void): void => {
  window.api.onQuickQueryToggle(callback);
};

/**
 * Subscribe to `focus-input` events from the main process.
 *
 * Fires when the main process wants to re-focus the launcher input without
 * clearing or toggling its open state (e.g. on window re-focus).
 */
export const onFocusInput = (callback: () => void): void => {
  window.api.onFocusInput(callback);
};

/**
 * Submit a trimmed query to the main process for dispatch.
 *
 * The main process resolves this promise once the query has been routed to
 * the agent API; resolution timing is opaque to the renderer. Rejection
 * signals a submission failure (e.g. main-process offline) so callers can
 * re-enable the input for a retry.
 */
export const submitQuickQuery = async (
  payload: QuickQueryPayload
): Promise<{ success: boolean }> => {
  return window.api.submitQuickQuery(payload);
};

/**
 * Ask the main process to hide the launcher window (bound to Escape).
 *
 * Fire-and-forget from the caller's perspective — the main process owns the
 * window lifecycle and will replay a `toggle({ open: true })` when the user
 * re-opens via the shortcut.
 */
export const hideQuickQuery = async (): Promise<{ success: boolean }> => {
  return window.api.hideQuickQuery();
};

/**
 * Ask the main process to resize the launcher BrowserWindow content area.
 *
 * Used when attachment chips appear/disappear so the fixed-size frameless
 * window grows just enough to show the chip row without clipping.
 */
export const resizeQuickQuery = async (
  payload: QuickQueryResizePayload
): Promise<{ success: boolean }> => {
  return window.api.resizeQuickQuery(payload);
};
