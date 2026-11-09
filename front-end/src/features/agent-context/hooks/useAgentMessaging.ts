import { useCallback } from 'react';

import type { Message } from '@/lib/api';

import { postAgentMessage } from '../api';
import type { StagedUserMessage } from '../types';
import type { AgentProviderState } from './useAgentProviderState';
import {
  buildLocalUserMessage,
  confirmLocalUserMessage,
  dropLocalUserMessage,
} from './optimisticUserMessages';

export function useAgentMessaging({
  messageHandlersRef,
  selectedAgentIdRef,
  setMessages,
}: Pick<AgentProviderState, 'messageHandlersRef' | 'selectedAgentIdRef' | 'setMessages'>) {
  const registerMessageHandler = useCallback(
    (subAgentId: string | null, handler: (message: Message) => void): (() => void) => {
      messageHandlersRef.current.set(subAgentId, handler);
      return () => {
        messageHandlersRef.current.delete(subAgentId);
      };
    },
    [messageHandlersRef],
  );

  const dispatchMessage = useCallback(
    (message: Message) => {
      const targetSubAgentId = message.metadata?.subAgentId ?? null;
      const handler = messageHandlersRef.current.get(targetSubAgentId);
      if (handler) {
        handler(message);
        return;
      }
      if (targetSubAgentId !== null) messageHandlersRef.current.get(null)?.(message);
    },
    [messageHandlersRef],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      const agentId = selectedAgentIdRef.current;
      if (!agentId) throw new Error('No agent selected');
      await postAgentMessage(agentId, text);
    },
    [selectedAgentIdRef],
  );

  const stageUserMessage = useCallback(
    (agentId: string, text: string): StagedUserMessage => {
      const local = buildLocalUserMessage(text);
      const isCurrent = () => selectedAgentIdRef.current === agentId;
      if (isCurrent()) setMessages((previous) => [...previous, local]);
      return {
        confirm: (server) => {
          if (!isCurrent()) return;
          setMessages((previous) => confirmLocalUserMessage(previous, local, server));
        },
        drop: () => {
          if (isCurrent())
            setMessages((previous) => dropLocalUserMessage(previous, local.message_id));
        },
      };
    },
    [selectedAgentIdRef, setMessages],
  );

  return { registerMessageHandler, dispatchMessage, sendMessage, stageUserMessage };
}
