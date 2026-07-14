import { useCallback } from 'react';

import type { Message } from '@/lib/api';

import { postAgentMessage } from '../api';
import type { AgentProviderState } from './useAgentProviderState';

export function useAgentMessaging(state: AgentProviderState) {
  const registerMessageHandler = useCallback(
    (subAgentId: string | null, handler: (message: Message) => void): (() => void) => {
      state.messageHandlersRef.current.set(subAgentId, handler);
      return () => {
        state.messageHandlersRef.current.delete(subAgentId);
      };
    },
    [state.messageHandlersRef],
  );

  const dispatchMessage = useCallback(
    (message: Message) => {
      const targetSubAgentId = message.metadata?.subAgentId ?? null;
      const handler = state.messageHandlersRef.current.get(targetSubAgentId);
      if (handler) {
        handler(message);
        return;
      }
      if (targetSubAgentId !== null) state.messageHandlersRef.current.get(null)?.(message);
    },
    [state.messageHandlersRef],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      const agentId = state.selectedAgentIdRef.current;
      if (!agentId) throw new Error('No agent selected');
      await postAgentMessage(agentId, text);
    },
    [state.selectedAgentIdRef],
  );

  return { registerMessageHandler, dispatchMessage, sendMessage };
}
