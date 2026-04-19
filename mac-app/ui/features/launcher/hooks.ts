/**
 * Business logic hooks for the launcher feature.
 *
 * Hooks layer: orchestrates api.ts + React state. No JSX, no direct fetch,
 * no direct window.api.* calls — route all IO through ./api.
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
import { onQuickQueryToggle, onFocusInput, submitQuickQuery, hideQuickQuery } from './api';
import { LAUNCHER_FOCUS_DELAY_MS } from './config';
import type { QuickQueryToggleState } from '../../../shared/types/ipc';

/**
 * Handle returned by `useLauncher` — the complete state + event surface the
 * `<Launcher>` component renders.
 */
export interface LauncherHandle {
  /** Current input value (controlled). */
  query: string;
  /** Setter used by the controlled `<input>`. */
  setQuery: (value: string) => void;
  /** True while a submit is in flight; disables the input and submit button. */
  submitting: boolean;
  /** Ref attached to the `<input>` so callers can programmatically focus it. */
  inputRef: RefObject<HTMLInputElement | null>;
  /** Submit the trimmed query. Safe to call with an empty string (no-op). */
  handleSubmit: (event?: FormEvent) => Promise<void>;
  /** Enter-key handler for the `<input>`. */
  handleKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
}

/**
 * Orchestrates the launcher's lifecycle:
 *   - Subscribes to toggle + focus-input events on mount.
 *   - Resets the query and focuses the input when the main process re-opens
 *     the launcher ({ open: true }). Ignores {open:false} per the original
 *     contract — the window closes via `hideQuickQuery()`, not via UI reset.
 *   - Handles Escape → `hideQuickQuery()` at the window level so Escape
 *     works even when the input has focus.
 *   - Exposes `handleSubmit` (trim-and-fire) and `handleKeyDown` (Enter →
 *     submit) for the `<Launcher>` component to bind to its form + input.
 */
export const useLauncher = (): LauncherHandle => {
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const toggleHandler = (state: QuickQueryToggleState): void => {
      if (state.open) {
        setQuery('');
        setSubmitting(false);
        setTimeout(() => inputRef.current?.focus(), LAUNCHER_FOCUS_DELAY_MS);
      }
    };

    onQuickQueryToggle(toggleHandler);

    // Listen for focus-input events from main process
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
      if (query.trim() === '' || submitting) return;

      setSubmitting(true);
      try {
        await submitQuickQuery({
          query: query.trim(),
          submittedAt: Date.now(),
        });
      } catch {
        setSubmitting(false);
      }
    },
    [query, submitting]
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'Enter') {
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
    handleSubmit,
    handleKeyDown,
  };
};
