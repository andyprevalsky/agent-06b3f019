/** Pending pause intent stays separate from canonical state until reconciled.
 *
 * ACTIVE -> requested -> accepted -> canonical PAUSED/terminal (intent removed)
 *                    \-> POST failure (intent removed, latest server view restored)
 * A failed/stale detail refresh cannot revoke an accepted pause. Each agent owns
 * its request token; switching agents or settling another request cannot clear it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentDetail } from '../types';

interface PauseRequest {
  token: symbol;
  accepted: boolean;
}

export function useAgentPauseRequests(agent: AgentDetail | null) {
  const requests = useRef(new Map<string, PauseRequest>());
  const [pending, setPending] = useState(new Map<string, PauseRequest>());
  const begin = useCallback((agentId: string) => {
    if (requests.current.has(agentId)) return null;
    const token = Symbol(agentId);
    requests.current.set(agentId, { token, accepted: false });
    setPending(new Map(requests.current));
    return token;
  }, []);
  const clear = useCallback((agentId: string, token?: symbol) => {
    if (!requests.current.has(agentId)) return;
    if (token !== undefined && requests.current.get(agentId)?.token !== token) return;
    requests.current.delete(agentId);
    setPending(new Map(requests.current));
  }, []);
  const accept = useCallback((agentId: string, token: symbol) => {
    if (requests.current.get(agentId)?.token !== token) return;
    requests.current.set(agentId, { token, accepted: true });
    setPending(new Map(requests.current));
  }, []);
  const agentId = agent?.agent_id;
  const status = agent?.status;
  useEffect(() => {
    if (
      agentId &&
      pending.get(agentId)?.accepted &&
      status !== 'ACTIVE' &&
      status !== 'STARTING_UP'
    ) {
      clear(agentId, pending.get(agentId)?.token);
    }
  }, [agentId, status, pending, clear]);
  return { pending, begin, accept, clear };
}
