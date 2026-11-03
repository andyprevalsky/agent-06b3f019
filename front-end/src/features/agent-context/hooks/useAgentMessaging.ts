import { useCallback } from 'react';

import type { Message } from '@/lib/api';

import { postAgentMessage } from '../api';
import type { AgentProviderState } from './useAgentProviderState';

export function useAgentMessaging({
  messageHandlersRef,
  selectedAgentIdRef,
}: Pick<AgentProviderState, 'messageHandlersRef' | 'selectedAgentIdRef'>) {
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

  return { registerMessageHandler, dispatchMessage, sendMessage };
}
