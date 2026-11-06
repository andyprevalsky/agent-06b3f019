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
  revision?: number;
}

/** Track each pause until its acknowledgment is reconciled by canonical control ordering. */
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
  const accept = useCallback((agentId: string, token: symbol, revision?: number) => {
    if (requests.current.get(agentId)?.token !== token) return;
    const acknowledged =
      revision !== undefined && Number.isSafeInteger(revision) && revision >= 0
        ? revision
        : undefined;
    requests.current.set(agentId, { token, accepted: true, revision: acknowledged });
    setPending(new Map(requests.current));
  }, []);
  const agentId = agent?.agent_id;
  const status = agent?.status;
  const revision = agent?.user_control_revision;
  useEffect(() => {
    const request = agentId ? pending.get(agentId) : undefined;
    if (!agentId || !request?.accepted) return;
    const acknowledged = request.revision;
    const hasRevision = typeof revision === 'number' && Number.isSafeInteger(revision);
    const resumed = hasRevision && acknowledged !== undefined && revision > acknowledged;
    const settled =
      status !== 'ACTIVE' &&
      status !== 'STARTING_UP' &&
      (acknowledged === undefined || (hasRevision && revision >= acknowledged));
    if (settled || resumed) {
      clear(agentId, request.token);
    }
  }, [agentId, status, revision, pending, clear]);
  return { pending, begin, accept, clear };
}
