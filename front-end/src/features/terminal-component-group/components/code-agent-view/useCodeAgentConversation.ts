/**
 * Everything the code-agent view shows, derived from the OWNER agent's
 * already-loaded messages (the session's rows ride the owner's existing
 * agent:<id> channel) — no extra list, fetch or poll for the view itself.
 * Lifecycle reuses the chip's view-model (useClaudeCodeChip): one WS for this
 * session while it runs, one saved-output read once it has ended, both
 * dropped when the view closes. The view mounts no terminal (transcript only).
 */

import { useMemo } from 'react';

import { useAgentContext } from '../../hooks';
import {
  codeAgentLabel,
  codeAgentTargetLabel,
  codeAgentToolCallId,
  latestCodeAgentMeta,
  type CodeAgentMeta,
  type CodeAgentProvider,
  type CodeAgentTranscriptEvent,
} from '../../hooks/codeAgentContract';
import { collectCodeAgentEvents } from '../../hooks/codeSessionTranscript';
import { desktopChipState } from '../../hooks/codeAgentSteering';
import type { ChipState } from '../../types';
import { useClaudeCodeChip, type ClaudeCodeChipVM } from '../claudeCodeChip.hooks';
import type { OpenCodeAgent } from './codeAgentViewState';

export type CodeAgentViewState = 'Running' | 'Paused' | 'Completed' | 'Failed';

const STATE_TEXT: Record<ChipState, CodeAgentViewState> = {
  spinning_up: 'Running',
  live: 'Running',
  verifying: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  paused: 'Paused',
};

export interface CodeAgentConversation {
  meta: CodeAgentMeta | null;
  provider: CodeAgentProvider;
  label: string;
  title: string;
  /** "Cloud · rose-ui/polish/speed" / "This Mac · ~/rose · <branch>"; null when unknown. */
  target: string | null;
  chipState: ChipState;
  stateText: CodeAgentViewState;
  events: CodeAgentTranscriptEvent[];
  toolCallId: string | undefined;
  vm: ClaudeCodeChipVM;
}

/** The session's live stream URL, from its spawn rows (latest wins). */
function sessionWsUrl(
  messages: ReturnType<typeof useAgentContext>['messages'],
  taskId: string,
): string | undefined {
  let url: string | undefined;
  for (const message of messages) {
    const metadata = message.metadata;
    if (metadata?.task_id !== taskId) continue;
    if (typeof metadata.ws_url === 'string' && metadata.ws_url !== '') url = metadata.ws_url;
  }
  return url;
}

/** Without a `code_agent` snapshot (legacy rows) the list's status names an ended session. */
function listChipState(status: OpenCodeAgent['status']): ChipState | null {
  if (status === 'COMPLETED' || status === 'CLOSED') return 'completed';
  if (status === 'ERROR') return 'failed';
  return null;
}

function targetLine(meta: CodeAgentMeta | null): string | null {
  if (!meta) return null;
  const branch = meta.branch || meta.code_session?.branch;
  return branch ? `${codeAgentTargetLabel(meta)} · ${branch}` : codeAgentTargetLabel(meta);
}

export function useCodeAgentConversation(open: OpenCodeAgent): CodeAgentConversation {
  const { messages } = useAgentContext();
  const { taskId } = open;
  const meta = useMemo(() => latestCodeAgentMeta(messages, taskId), [messages, taskId]);
  const events = useMemo(() => collectCodeAgentEvents(messages, taskId), [messages, taskId]);
  const toolCallId = useMemo(() => codeAgentToolCallId(messages, taskId), [messages, taskId]);
  const wsUrl = useMemo(() => sessionWsUrl(messages, taskId), [messages, taskId]);
  const provider: CodeAgentProvider = meta?.provider ?? open.provider ?? 'claude';
  const vm = useClaudeCodeChip(taskId, wsUrl, false, provider);
  const chipState = meta
    ? desktopChipState(meta, vm.chipState)
    : vm.chipState === 'spinning_up'
      ? (listChipState(open.status) ?? vm.chipState)
      : vm.chipState;
  const label = codeAgentLabel(provider);
  return {
    meta,
    provider,
    label,
    title: open.title || meta?.title || label,
    target: targetLine(meta),
    chipState,
    stateText: STATE_TEXT[chipState],
    events,
    toolCallId,
    vm,
  };
}
