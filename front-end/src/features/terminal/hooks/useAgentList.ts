import { reconcileAgent } from '@/lib/progressEstimate';
/**
 * Terminal feature — agent list loading and polling hook.
 *
 * Request state:
 *   IDLE --loadAgents()--> LOADING --final request settles--> IDLE
 *                            |  ^
 *                            +--+ overlapping request starts/settles
 *   IDLE --cannot submit goals----------------> IDLE
 *
 * hasLoadedAgents: false until the first request settles (success or
 * failure), then true. Background polls keep isLoadingAgents's in-flight
 * meaning, so views that must not tear down on every poll gate their
 * first-load spinner on hasLoadedAgents instead.
 *
 * Session end (canSubmitGoals -> false) clears agents, resets hasLoadedAgents
 * and drops every in-flight result, so a later session never sees the previous
 * account's list or skips its own first-load spinner.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

import { useToast } from '@/hooks/use-toast';

import { AGENT_POLL_INTERVAL_MS } from '../config';
import { fetchAgents } from '../api';
import type { Agent } from '../types';

export function useAgentList(canSubmitGoals: boolean) {
  const { toast } = useToast();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(false);
  const [hasLoadedAgents, setHasLoadedAgents] = useState(false);
  const latestLoad = useRef(0);
  const activeLoads = useRef(0);
  const session = useRef(0);

  const loadAgents = useCallback(async () => {
    const loadId = ++latestLoad.current;
    const loadSession = session.current;
    activeLoads.current += 1;
    setIsLoadingAgents(true);
    try {
      const fetched = await fetchAgents();
      if (loadId === latestLoad.current && loadSession === session.current)
        setAgents((previous) => {
          const byId = new Map(previous.map((agent) => [agent.agent_id, agent]));
          return fetched.map((agent) => reconcileAgent(byId.get(agent.agent_id), agent));
        });
    } catch (_err: unknown) {
      toast({ title: 'Error', description: 'Failed to load agents', variant: 'destructive' });
    } finally {
      activeLoads.current -= 1;
      setIsLoadingAgents(activeLoads.current > 0);
      if (loadSession === session.current) setHasLoadedAgents(true);
    }
  }, [toast]);

  useEffect(() => {
    if (canSubmitGoals) {
      void loadAgents();
      return;
    }
    session.current += 1;
    setAgents([]);
    setHasLoadedAgents(false);
  }, [canSubmitGoals, loadAgents]);

  useEffect(() => {
    if (!canSubmitGoals) return;
    const id = setInterval(() => void loadAgents(), AGENT_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [canSubmitGoals, loadAgents]);

  return { agents, setAgents, isLoadingAgents, hasLoadedAgents, loadAgents };
}
