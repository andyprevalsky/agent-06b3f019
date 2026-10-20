/**
 * Shared context object + URL helpers for the Rose Desktop code-agent view
 * (a Claude Code / Codex session opened from the left bar as its own
 * conversation). Split from the provider so the sidebar, the chat column and
 * the view read it without importing the provider module.
 *
 * DEEP LINK: ?agent-id=<owner agent>&code-agent=<task id> (the existing
 * agent-id pattern plus one param); the param is written on open and removed
 * on close with history.replaceState, like agent-id itself.
 */

import { createContext, useContext } from 'react';

import type { CodeAgentListItem, CodeAgentProviderName, CodeAgentStatus } from '@/lib/api/tree';

export const CODE_AGENT_URL_PARAM = 'code-agent';

/** The code agent whose conversation replaces the chat column. */
export interface OpenCodeAgent {
  /** Code session id (`task_id` on the owner's messages, `code_agent_id` in the list). */
  taskId: string;
  /** The Rose agent that spawned it; its messages hold the session's rows. */
  ownerAgentId: string;
  /** From the left-bar row; null for a deep link (the messages' snapshot decides). */
  provider: CodeAgentProviderName;
  title: string;
  status: CodeAgentStatus | null;
}

export interface CodeAgentViewValue {
  openCodeAgent: OpenCodeAgent | null;
  /** Open a code agent (selects its owner agent when another one is selected). */
  open: (codeAgent: OpenCodeAgent) => void;
  /** Back to the owner agent's conversation. */
  close: () => void;
}

export const CodeAgentViewContext = createContext<CodeAgentViewValue | null>(null);

/** null outside a CodeAgentViewProvider (stock UI, isolated renders). */
export function useCodeAgentView(): CodeAgentViewValue | null {
  return useContext(CodeAgentViewContext);
}

/** A left-bar row (GET /api/agents/code-agents item) as the code agent to open. */
export function openCodeAgentFromRow(row: CodeAgentListItem): OpenCodeAgent {
  return {
    taskId: row.code_agent_id,
    ownerAgentId: row.owner_agent_id,
    provider: row.provider,
    title: row.title.trim(),
    status: row.status,
  };
}

/** The code agent named by the URL, when it also names the owner agent. */
export function codeAgentFromUrl(): OpenCodeAgent | null {
  if (typeof window === 'undefined') return null;
  const params = new URL(window.location.href).searchParams;
  const taskId = params.get(CODE_AGENT_URL_PARAM)?.trim() ?? '';
  const ownerAgentId = params.get('agent-id')?.trim() ?? '';
  if (taskId === '' || ownerAgentId === '') return null;
  return { taskId, ownerAgentId, provider: null, title: '', status: null };
}

export function writeCodeAgentUrl(taskId: string | null): void {
  const url = new URL(window.location.href);
  if (taskId === null) {
    if (!url.searchParams.has(CODE_AGENT_URL_PARAM)) return;
    url.searchParams.delete(CODE_AGENT_URL_PARAM);
  } else {
    url.searchParams.set(CODE_AGENT_URL_PARAM, taskId);
  }
  window.history.replaceState(window.history.state ?? {}, '', url.toString());
}
