import { useRef } from 'react';
import type { Message } from '@/lib/api';

export interface ReceivedInserts {
  agentId: string | null;
  ids: Set<string>;
  browserMessages: Map<string, Message>;
}

/** Retain notification identities across reconnects for the selected transcript. */
export function useReceivedInserts(selectedAgentId: string | null) {
  const receivedRef = useRef<ReceivedInserts>({
    agentId: null,
    ids: new Set(),
    browserMessages: new Map(),
  });
  if (receivedRef.current.agentId !== selectedAgentId) {
    receivedRef.current = {
      agentId: selectedAgentId,
      ids: new Set(),
      browserMessages: new Map(),
    };
  }
  return receivedRef;
}
