/**
 * The code agent as the selected agent of the EXISTING transcript and query box.
 *
 * Wraps the code-agent view in an AgentContext whose agent is the code session
 * and whose messages are its projected main-chat rows (codeSessionMessages), so
 * MessageList renders it through the root path: user messages, work folded into
 * "Worked for …" (groupTrajectoryWork), thought rows and the live thinking
 * indicator. Everything else is the owner's context unchanged.
 *
 *   code session state → agent.status:
 *     spinning_up / live / verifying → ACTIVE · completed → COMPLETED
 *     failed → FAILED · paused → PAUSED
 *   agent.model / speed / context_size ← the session's own records
 *     (codeSessionSettings); unknown stays empty.
 *
 * No fetch, poll or subscription: the owner's loaded messages already carry the
 * session's rows (agent:<owner> channel). New rows re-derive the list.
 */

import { useMemo, useRef, type ReactNode } from 'react';

import type { Message } from '@/lib/api/types';
import type { ChipState } from '../../types';
import { AgentContext, useAgentContext, type AgentContextValue } from '../../hooks';
import { eventTimeMs } from '../../hooks/codeAgentContract';
import { useLocalEchoes } from '../../hooks/codeAgentLocalState';
import { codeSessionMessages } from '../../hooks/codeSessionMessages';
import type { CodeSessionSettings } from '../../hooks/codeSessionSettings';
import type { CodeAgentConversation } from './useCodeAgentConversation';
import { codeAgentDetail } from './codeAgentDetail';

const NO_BUBBLES = new Map();
const NO_TOOLS = new Map();
const noUnsubscribe = () => () => {};
const noop = () => {};

function sessionState(chipState: ChipState): 'running' | 'completed' | 'failed' | 'paused' {
  return chipState === 'completed' || chipState === 'failed' || chipState === 'paused'
    ? chipState
    : 'running';
}

export function CodeAgentContextProvider({
  taskId,
  c,
  settings,
  onSend,
  children,
}: {
  taskId: string;
  c: CodeAgentConversation;
  settings: CodeSessionSettings;
  onSend: (text: string) => Promise<unknown>;
  children: ReactNode;
}) {
  const owner = useAgentContext();
  const echoes = useLocalEchoes(taskId);
  const streamedTextsRef = useRef<Set<string>>(new Set());
  const ownerAgentId = owner.selectedAgentId ?? '';
  const state = sessionState(c.chipState);
  const endedAt = eventTimeMs(c.meta?.ended_at);
  const messages = useMemo<Message[]>(
    () =>
      codeSessionMessages({
        messages: owner.messages,
        taskId,
        ownerAgentId,
        provider: c.provider,
        sessionState: state,
        sessionEndedAt: endedAt,
        echoes,
      }),
    [owner.messages, taskId, ownerAgentId, c.provider, state, endedAt, echoes],
  );
  const firstAt = messages[0]?.timestamp ?? new Date(0).toISOString();
  const agent = useMemo(
    () => codeAgentDetail(taskId, ownerAgentId, c, settings, firstAt, messages.length),
    [taskId, ownerAgentId, c, settings, firstAt, messages.length],
  );
  const value = useMemo<AgentContextValue>(
    () => ({
      ...owner,
      agent,
      selectedAgentId: taskId,
      messages,
      streamingBubbles: NO_BUBBLES,
      streamingPlan: null,
      streamingAttention: null,
      streamingTools: NO_TOOLS,
      streamedTextsRef,
      registerMessageHandler: noUnsubscribe,
      sendMessage: async (text: string) => {
        await onSend(text);
      },
      isLoadingAgent: false,
      forceResubscribe: noop,
      isChatMode: false,
    }),
    [owner, agent, taskId, messages, onSend],
  );
  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}
