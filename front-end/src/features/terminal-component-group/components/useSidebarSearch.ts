/**
 * STATE MACHINE: sidebar chat search
 *
 * [IDLE: empty query, base list]
 *   --type--> [DEBOUNCING: local title/goal matches remain visible]
 *   --250ms--> [SEARCHING: one owner-scoped API request]
 *   --success--> [READY: local metadata + remote message matches]
 *   --failure--> [ERROR: explicit error, never a silent fallback]
 *   --edit/clear--> abort prior request and return to DEBOUNCING/IDLE
 */
import { useEffect, useMemo, useState } from 'react';
import { searchAgents } from '@/lib/api';
import type { Agent } from '../hooks';

const SEARCH_DEBOUNCE_MS = 250;

interface RemoteSearchState {
  query: string;
  agents: Agent[];
  isSearching: boolean;
  error: string | null;
}

const EMPTY_STATE: RemoteSearchState = {
  query: '',
  agents: [],
  isSearching: false,
  error: null,
};

export function useSidebarSearch(baseAgents: Agent[], query: string) {
  const normalizedQuery = query.trim();
  const [remote, setRemote] = useState<RemoteSearchState>(EMPTY_STATE);

  useEffect(() => {
    if (normalizedQuery === '') {
      setRemote(EMPTY_STATE);
      return;
    }

    const controller = new AbortController();
    setRemote({ query: normalizedQuery, agents: [], isSearching: true, error: null });
    const timeout = window.setTimeout(() => {
      void searchAgents(normalizedQuery, controller.signal)
        .then((agents) => {
          setRemote({ query: normalizedQuery, agents, isSearching: false, error: null });
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setRemote({
            query: normalizedQuery,
            agents: [],
            isSearching: false,
            error: 'Search failed. Please try again.',
          });
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [normalizedQuery]);

  const activeRemote = remote.query === normalizedQuery ? remote : EMPTY_STATE;
  const agents = useMemo(() => {
    const merged = new Map(baseAgents.map((agent) => [agent.agent_id, agent]));
    for (const agent of activeRemote.agents) merged.set(agent.agent_id, agent);
    return [...merged.values()];
  }, [baseAgents, activeRemote.agents]);
  const contentMatchAgentIds = useMemo(
    () => new Set(activeRemote.agents.map((agent) => agent.agent_id)),
    [activeRemote.agents],
  );

  return {
    agents,
    contentMatchAgentIds,
    isSearching: activeRemote.isSearching,
    searchError: activeRemote.error,
  };
}
