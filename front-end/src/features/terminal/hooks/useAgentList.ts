import { reconcileAgent } from '@/lib/progressEstimate';
/**
 * Terminal feature — agent list loading and polling hook.
 *
 * Request state:
 *   IDLE --loadAgents()--> LOADING --final request settles--> IDLE
 *                            |  ^
 *                            +--+ overlapping request starts/settles
 *   IDLE --cannot submit goals----------------> IDLE
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
  const latestLoad = useRef(0);
  const activeLoads = useRef(0);

  const loadAgents = useCallback(async () => {
    const loadId = ++latestLoad.current;
    activeLoads.current += 1;
    setIsLoadingAgents(true);
    try {
      const fetched = await fetchAgents();
      if (loadId === latestLoad.current)
        setAgents((previous) => {
          const byId = new Map(previous.map((agent) => [agent.agent_id, agent]));
          return fetched.map((agent) => reconcileAgent(byId.get(agent.agent_id), agent));
        });
    } catch (_err: unknown) {
      toast({ title: 'Error', description: 'Failed to load agents', variant: 'destructive' });
    } finally {
      activeLoads.current -= 1;
      setIsLoadingAgents(activeLoads.current > 0);
    }
  }, [toast]);

  useEffect(() => {
    if (canSubmitGoals) void loadAgents();
  }, [canSubmitGoals, loadAgents]);

  useEffect(() => {
    if (!canSubmitGoals) return;
    const id = setInterval(() => void loadAgents(), AGENT_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [canSubmitGoals, loadAgents]);

  return { agents, setAgents, isLoadingAgents, loadAgents };
}
