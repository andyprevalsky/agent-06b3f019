/**
 * Type definitions for the launcher feature — the floating Quick-Query
 * window that overlays on top of the user's desktop.
 *
 * Types layer: external packages + shared provider types only. No imports
 * from own api/hooks/components.
 */

/**
 * Local (not-yet-uploaded) file held in the launcher until submit.
 * Upload happens in the main window after IPC — the launcher has no HTTP boundary.
 *
 * STATE MACHINE (per file):
 *   [held] --remove--> (gone)
 *   [held] --submit--> serialized into QuickQueryAttachment
 */
export interface LauncherLocalAttachment {
  id: string;
  file: File;
  /** The screenshot captured when the launcher opened. */
  autoCaptured?: boolean;
}
