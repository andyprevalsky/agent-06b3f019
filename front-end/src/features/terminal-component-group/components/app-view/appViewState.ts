/**
 * Shared context object and types for the Rose Desktop full-screen app view
 * (UI ledger rows 10/39). Split from the provider so the code-agent chip's
 * preview card and the view itself don't import the module that owns the state.
 *
 *   code_agent { task_id, title, provider } (+ preview_url shows the card) ──click──► openApp
 *                                                               │
 *   AgentChatArea ◄── useAppView().target (the open code session) ┘
 */

import { createContext, useContext } from 'react';

import type { CodeAgentProvider } from '../../hooks/codeAgentContract';

/** The code session whose live preview is open full screen. */
export interface AppViewTarget {
  taskId: string;
  /** The code agent's task subtitle; the header falls back to "Preview". */
  title: string | null;
  /** Whose session the query box steers ("Message Claude Code directly…"). */
  provider: CodeAgentProvider;
}

export interface AppViewValue {
  target: AppViewTarget | null;
  openApp: (target: AppViewTarget) => void;
  closeApp: () => void;
}

export const AppViewContext = createContext<AppViewValue | null>(null);

/** null outside an AppViewProvider (stock layouts, isolated tests). */
export function useAppView(): AppViewValue | null {
  return useContext(AppViewContext);
}

/** Header title of an open view. */
export function appViewTitle(target: AppViewTarget): string {
  return target.title ?? 'Preview';
}
