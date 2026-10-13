import { useRef } from 'react';

export interface ReceivedInserts {
  agentId: string | null;
  ids: Set<string>;
}

/** Retain notification identities across reconnects for the selected transcript. */
export function useReceivedInserts(selectedAgentId: string | null) {
  const receivedRef = useRef<ReceivedInserts>({ agentId: null, ids: new Set() });
  if (receivedRef.current.agentId !== selectedAgentId) {
    receivedRef.current = { agentId: selectedAgentId, ids: new Set() };
  }
  return receivedRef;
}
