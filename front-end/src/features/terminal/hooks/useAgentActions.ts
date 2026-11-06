/**
 * Terminal feature — agent lifecycle actions hook.
 *
 * Handles create, resume, pause, select, feedback, and detail refresh.
 */

import { useState, useCallback, useRef } from 'react';

import { useToast } from '@/hooks/use-toast';

import {
  fetchAgentDetail,
  createAgent,
  resumeAgent,
  pauseAgent,
  findBlueprintByGoal,
  submitBlueprintFeedback,
} from '../api';
import type { AgentDetailResponse } from '@/lib/api';
import type { BlueprintFeedback, TerminalView, CreateAgentPayload, AgentDetail } from '../types';

interface UseAgentActionsArgs {
  selectedAgentId: string | null;
  agentDetail: AgentDetail | null;
  applyAgentDetail: (agentId: string, data: AgentDetailResponse) => boolean;
  setSelectedAgentIdContext: (id: string | null) => void;
  setCurrentView: (v: TerminalView) => void;
  clientSource: AgentDetail['source'];
  loadAgents: () => Promise<void>;
}

export function useAgentActions({
  selectedAgentId,
  agentDetail,
  applyAgentDetail,
  setSelectedAgentIdContext,
  setCurrentView,
  clientSource,
  loadAgents,
}: UseAgentActionsArgs) {
  const { toast } = useToast();
  const [resumingAgentId, setResumingAgentId] = useState<string | null>(null);
  const [pausingAgentId, setPausingAgentId] = useState<string | null>(null);
  const isPausing = pausingAgentId !== null && pausingAgentId === selectedAgentId;
  const selectedAgentIdRef = useRef(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;

  const refreshAgentDetail = useCallback(
    async (agentId: string) => {
      try {
        const data = await fetchAgentDetail(agentId);
        if (selectedAgentIdRef.current !== agentId) return;
        applyAgentDetail(agentId, data);
      } catch (err: unknown) {
        console.error('Failed to refresh agent details:', err);
      }
    },
    [applyAgentDetail],
  );

  const handleSelectAgent = useCallback(
    (agentId: string | null) => {
      if (agentId) {
        setCurrentView('agents');
        setSelectedAgentIdContext(agentId);
      } else {
        setSelectedAgentIdContext(null);
      }
    },
    [setCurrentView, setSelectedAgentIdContext],
  );

  const handleCreateAgent = useCallback(
    async (data: CreateAgentPayload) => {
      const newAgent = await createAgent({ ...data, source: clientSource });
      await loadAgents();
      setCurrentView('agents');
      setSelectedAgentIdContext(newAgent.agent_id);
    },
    [clientSource, loadAgents, setCurrentView, setSelectedAgentIdContext],
  );

  const handleResumeAgent = useCallback(
    async (agentId: string) => {
      try {
        setResumingAgentId(agentId);
        await resumeAgent(agentId);
        if (agentId === selectedAgentId) await refreshAgentDetail(agentId);
        await loadAgents();
        toast({ title: 'Success', description: 'Agent resumed' });
      } catch (_e: unknown) {
        toast({ title: 'Error', description: 'Failed to resume agent', variant: 'destructive' });
      } finally {
        setResumingAgentId(null);
      }
    },
    [selectedAgentId, refreshAgentDetail, loadAgents, toast],
  );

  const handlePauseAgent = useCallback(async () => {
    if (!selectedAgentId || !agentDetail) return;
    try {
      setPausingAgentId(selectedAgentId);
      await pauseAgent(selectedAgentId);
      await refreshAgentDetail(selectedAgentId);
      toast({ title: 'Agent pausing', description: 'The agent will pause shortly' });
    } catch (_e: unknown) {
      toast({ title: 'Error', description: 'Failed to pause agent', variant: 'destructive' });
    } finally {
      setPausingAgentId((current) => (current === selectedAgentId ? null : current));
    }
  }, [selectedAgentId, agentDetail, refreshAgentDetail, toast]);

  const handleSubmitFeedback = useCallback(
    async (feedback: BlueprintFeedback) => {
      if (!agentDetail) return;
      try {
        const blueprint = await findBlueprintByGoal(agentDetail.goal);
        if (blueprint) {
          await submitBlueprintFeedback(blueprint.id, {
            ...feedback,
            agentId: agentDetail.agent_id,
          });
        } else {
          console.warn('No blueprint found for feedback');
        }
      } catch (err: unknown) {
        console.error('Failed to submit feedback:', err);
        throw err;
      }
    },
    [agentDetail],
  );

  return {
    resumingAgentId,
    isPausing,
    refreshAgentDetail,
    handleSelectAgent,
    handleCreateAgent,
    handleResumeAgent,
    handlePauseAgent,
    handleSubmitFeedback,
  };
}
