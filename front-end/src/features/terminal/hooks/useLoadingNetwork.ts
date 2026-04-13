/**
 * Terminal feature — loading network animation hook.
 *
 * Manages the "Loading AI Network..." dots animation
 * and auto-clears when the agent finishes loading.
 */

import { useState, useEffect } from 'react';

export function useLoadingNetwork(
  selectedAgentId: string | null,
  isLoadingAgent: boolean,
  agentStatus: string | undefined,
) {
  const [isLoadingNetwork, setIsLoadingNetwork] = useState(false);
  const [loadingDots, setLoadingDots] = useState('.');

  useEffect(() => {
    if (!isLoadingNetwork) return;
    const seq = ['.', '..', '...'];
    let idx = 0;
    const interval = setInterval(() => {
      idx = (idx + 1) % seq.length;
      setLoadingDots(seq[idx]);
    }, 500);
    return () => clearInterval(interval);
  }, [isLoadingNetwork]);

  useEffect(() => {
    if (selectedAgentId && !isLoadingAgent && agentStatus !== 'STARTING_UP') {
      setIsLoadingNetwork(false);
    }
  }, [selectedAgentId, isLoadingAgent, agentStatus]);

  return { isLoadingNetwork, setIsLoadingNetwork, loadingDots };
}
