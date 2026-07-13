/**
 * Terminal feature — agent list loading and polling hook.
 *
 * Request state:
 *   IDLE --loadAgents()--> LOADING --settled--> IDLE
 *   IDLE --cannot submit goals----------------> IDLE
 */

import { useState, useEffect, useCallback } from 'react';

import { useToast } from '@/hooks/use-toast';

import { AGENT_POLL_INTERVAL_MS } from '../config';
import { fetchAgents } from '../api';
import type { Agent } from '../types';

export function useAgentList(canSubmitGoals: boolean) {
  const { toast } = useToast();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(false);

  const loadAgents = useCallback(async () => {
    setIsLoadingAgents(true);
    try {
      const fetched = await fetchAgents();
      setAgents(fetched);
    } catch (_err: unknown) {
      toast({ title: 'Error', description: 'Failed to load agents', variant: 'destructive' });
    } finally {
      setIsLoadingAgents(false);
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
