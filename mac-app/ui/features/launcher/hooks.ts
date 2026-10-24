/**
 * Business logic hooks for the launcher feature.
 *
 * Hooks layer: orchestrates api.ts + React state. No JSX, no direct fetch,
 * no direct window.api.* calls — route all IO through ./api.
 *
 * STATE MACHINE:
 *   [idle] --type--> [has_text]
 *   [idle|has_text] --dragover--> [drag_over] --drop--> [has_files]
 *   [has_text|has_files] --submit--> [submitting]
 *     [submitting] --ok--> (window hides via main)
 *     [submitting] --err--> [has_text|has_files]
 *   [any] --Escape--> hideQuickQuery()
 *   toggle({open:true}) --> reset to [idle]
 *   toggle({open:true, screenshot}) --> reset to [has_files] (screenshot held)
 *
 * System context (file attach):
 *   Desktop drag / paperclip / Alt+Space screenshot → Launcher (hold File[])
 *     → IPC bytes → Main window → uploadAttachment → createAgent(attachments)
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import {
  onQuickQueryToggle,
  onFocusInput,
  submitQuickQuery,
  hideQuickQuery,
  resizeQuickQuery,
} from './api';
import { LAUNCHER_FOCUS_DELAY_MS, launcherWindowHeightFromPill } from './config';
import type { QuickQueryToggleState } from '../../../shared/types/ipc';
import { useLauncherAttachments, type LauncherAttachmentsHandle } from './useLauncherAttachments';
import type { LauncherLocalAttachment } from './types';

/**
 * Handle returned by `useLauncher` — the complete state + event surface the
 * `<Launcher>` component renders.
 */
export interface LauncherHandle {
  /** Current input value (controlled). */
  query: string;
  /** Setter used by the controlled `<textarea>`. */
  setQuery: (value: string) => void;
  /** True while a submit is in flight; disables the input and submit button. */
  submitting: boolean;
  /** Ref attached to the `<textarea>` so callers can programmatically focus it. */
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** Local files held until submit (not uploaded in this window). */
  attachments: LauncherLocalAttachment[];
  /** True while a file drag is hovering the drop target. */
  isDragOver: boolean;
  /** Last attach validation error (oversized file / total cap), if any. */
  attachError: string | null;
  /** Drag/drop handlers for the drop target. */
  dragHandlers: LauncherAttachmentsHandle['dragHandlers'];
  /** Remove one held local file by id. */
  removeAttachment: (id: string) => void;
  /** Add files from the paperclip picker (same path as drop). */
  addFiles: (files: FileList | File[]) => void;
  /** Submit the trimmed query and/or held files. Safe to call empty (no-op). */
  handleSubmit: (event?: FormEvent) => Promise<void>;
  /** Enter-key handler for the `<textarea>` (Shift+Enter inserts a newline). */
  handleKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
}

/**
 * Orchestrates the launcher's lifecycle:
 *   - Subscribes to toggle + focus-input events on mount.
 *   - Resets the query/attachments and focuses the input when the main
 *     process re-opens the launcher ({ open: true }), holding the screenshot
 *     of the caller's screen when main captured one.
 *   - Handles Escape → `hideQuickQuery()` at the window level.
 *   - Serializes held files into the submit IPC payload (no fetch here).
 */
export const useLauncher = (): LauncherHandle => {
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const attachments = useLauncherAttachments();
  const resetAttachmentsRef = useRef(attachments.reset);
  resetAttachmentsRef.current = attachments.reset;
  const serializeAttachmentsRef = useRef(attachments.serializeForSubmit);
  serializeAttachmentsRef.current = attachments.serializeForSubmit;
  const attachmentCountRef = useRef(attachments.attachments.length);
  attachmentCountRef.current = attachments.attachments.length;

  useEffect(() => {
    const toggleHandler = (state: QuickQueryToggleState): void => {
      if (state.open) {
        setQuery('');
        setSubmitting(false);
        resetAttachmentsRef.current(state.screenshot);
        setTimeout(() => inputRef.current?.focus(), LAUNCHER_FOCUS_DELAY_MS);
      }
    };

    onQuickQueryToggle(toggleHandler);

    onFocusInput(() => {
      inputRef.current?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void hideQuickQuery();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const handleSubmit = useCallback(
    async (event?: FormEvent): Promise<void> => {
      event?.preventDefault();
      const trimmed = query.trim();
      const hasFiles = attachmentCountRef.current > 0;
      if ((trimmed === '' && !hasFiles) || submitting) return;

      setSubmitting(true);
      try {
        const serialized = hasFiles ? await serializeAttachmentsRef.current() : undefined;
        await submitQuickQuery({
          query: trimmed,
          submittedAt: Date.now(),
          attachments: serialized && serialized.length > 0 ? serialized : undefined,
        });
      } catch {
        setSubmitting(false);
      }
    },
    [query, submitting]
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit]
  );

  return {
    query,
    setQuery,
    submitting,
    inputRef,
    attachments: attachments.attachments,
    isDragOver: attachments.isDragOver,
    attachError: attachments.attachError,
    dragHandlers: attachments.dragHandlers,
    removeAttachment: attachments.remove,
    addFiles: attachments.addFiles,
    handleSubmit,
    handleKeyDown,
  };
};

/**
 * Keeps the frameless launcher window sized to the rendered pill.
 *
 * Lives in the hooks layer because resizing is an IPC call: components render,
 * hooks orchestrate ./api.
 */
export const useLauncherWindowHeight = (pillHeight: number): void => {
  useEffect(() => {
    // The launcher window and its IPC bridge can tear down mid-resize (the window
    // is hidden on blur), which rejects this call. An unhandled rejection there
    // would surface as a renderer error for a resize that no longer matters, so
    // swallow it: there is no window left to size.
    resizeQuickQuery({ height: launcherWindowHeightFromPill(pillHeight) }).catch(() => {});
  }, [pillHeight]);
};
