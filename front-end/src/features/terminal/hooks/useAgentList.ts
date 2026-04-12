/**
 * Terminal feature — agent list loading and polling hook.
 */

import { useState, useEffect, useCallback } from 'react';

import { useToast } from '@/hooks/use-toast';

import { AGENT_POLL_INTERVAL_MS } from '../config';
import { fetchAgents } from '../api';
import type { Agent } from '../types';

export function useAgentList(canSubmitGoals: boolean) {
  const { toast } = useToast();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(true);
  const [isFirstLoad, setIsFirstLoad] = useState(true);

  const loadAgents = useCallback(async () => {
    try {
      if (isFirstLoad) setIsLoadingAgents(true);
      const fetched = await fetchAgents();
      setAgents(fetched);
    } catch (_err: unknown) {
      toast({ title: 'Error', description: 'Failed to load agents', variant: 'destructive' });
    } finally {
      if (isFirstLoad) {
        setIsLoadingAgents(false);
        setIsFirstLoad(false);
      }
    }
  }, [isFirstLoad, toast]);

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
