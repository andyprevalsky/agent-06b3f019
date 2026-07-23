/**
 * STATE MACHINE: terminal message sending
 *
 * [IDLE] -- existing agent --> [POSTING MESSAGE] --------> [IDLE]
 *    |
 *    +-- new goal --> [STAGED AGENT + USER BUBBLE] --> [CREATING]
 *                              |                         |
 *                              |                         +-- success --> [CANONICAL]
 *                              +-- selected-id-scoped failure ---------> [ROLLED BACK]
 *
 * The staged transition is synchronous. Agent creation, canonical detail,
 * and the sidebar refresh happen after the new conversation is visible. Fast
 * Mode and Simulator Mode are captured in the create request for that agent.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import * as amplitude from '@amplitude/analytics-browser';

import { useToast } from '@/hooks/use-toast';
import { DEFAULT_FAST_MODE_USER_IDS, FAST_MODE_USER_IDS } from '@/lib/fastModeAccounts';
import { SIMULATOR_USER_IDS } from '@/lib/simulatorAccounts';
import { getItem, removeItem } from '@/lib/storage';

import { DEFAULT_MODEL, DEFAULT_PRICE_LIMIT_CENTS } from '../config';
import { createAgent, postMessage, resumeAgent, checkAndRespondToAttention } from '../api';
import type { FilePointer, AgentDetail, PendingAgentCreationInput, TerminalView } from '../types';

export interface UseMessageSendingArgs {
  selectedAgentId: string | null;
  agentDetail: AgentDetail | null;
  canSubmitGoals: boolean;
  isFullySignedIn: boolean;
  userId?: string | null;
  clientSource: string;
  setCurrentView: (v: TerminalView) => void;
  setLoginModalOpen: (v: boolean) => void;
  setIsLoadingNetwork: (v: boolean) => void;
  loadAgents: () => Promise<void>;
  stagePendingAgentCreation: (input: PendingAgentCreationInput) => void;
  reconcilePendingAgentCreation: (agentId: string) => Promise<void>;
  rollbackPendingAgentCreation: (agentId: string) => boolean;
}

export function useMessageSending({
  selectedAgentId,
  agentDetail,
  canSubmitGoals,
  isFullySignedIn,
  userId,
  clientSource,
  setCurrentView,
  setLoginModalOpen,
  setIsLoadingNetwork,
  loadAgents,
  stagePendingAgentCreation,
  reconcilePendingAgentCreation,
  rollbackPendingAgentCreation,
}: UseMessageSendingArgs) {
  const { toast } = useToast();

  const [messageInput, setMessageInput] = useState(() => {
    const prefill = getItem('onboarding_prefill_query');
    if (prefill) {
      removeItem('onboarding_prefill_query');
      return prefill;
    }
    return '';
  });
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const [pendingPriceLimitCents, setPendingPriceLimitCents] = useState(DEFAULT_PRICE_LIMIT_CENTS);
  // Fast Mode aggressive cache — session-only, account-scoped default, never persisted client-side.
  const [fastMode, setFastModeState] = useState(false);
  // World Model simulator — session-only, account-scoped, default off, never persisted client-side.
  const [simulatorMode, setSimulatorModeState] = useState(false);

  const messageInputRef = useRef<string>('');
  const pendingSubmitRef = useRef(false);
  const autoSubmitRef = useRef(false);
  const fastModeUserOverrideRef = useRef(false);
  const userCanUseFastMode = userId != null && FAST_MODE_USER_IDS.includes(userId);
  const userCanUseSimulator = userId != null && SIMULATOR_USER_IDS.includes(userId);

  useEffect(() => {
    messageInputRef.current = messageInput;
  }, [messageInput]);

  useEffect(() => {
    if (!userCanUseFastMode) {
      fastModeUserOverrideRef.current = false;
      setFastModeState(false);
      return;
    }

    if (
      selectedAgentId !== null &&
      agentDetail?.agent_id === selectedAgentId &&
      typeof agentDetail.fast_mode_cache_enabled === 'boolean'
    ) {
      fastModeUserOverrideRef.current = false;
      setFastModeState(agentDetail.fast_mode_cache_enabled);
      return;
    }

    if (selectedAgentId !== null || fastModeUserOverrideRef.current) return;
    setFastModeState(userId != null && DEFAULT_FAST_MODE_USER_IDS.includes(userId));
  }, [
    agentDetail?.agent_id,
    agentDetail?.fast_mode_cache_enabled,
    selectedAgentId,
    userCanUseFastMode,
    userId,
  ]);

  const setFastMode = useCallback((enabled: boolean) => {
    fastModeUserOverrideRef.current = true;
    setFastModeState(enabled);
    if (enabled) setSimulatorModeState(false);
  }, []);

  useEffect(() => {
    if (!userCanUseSimulator) {
      setSimulatorModeState(false);
      return;
    }
    if (selectedAgentId !== null && agentDetail?.agent_id === selectedAgentId) {
      setSimulatorModeState(agentDetail.world_model_mode === 'simulate');
    }
  }, [agentDetail?.agent_id, agentDetail?.world_model_mode, selectedAgentId, userCanUseSimulator]);

  const setSimulatorMode = useCallback((enabled: boolean) => {
    setSimulatorModeState(enabled);
    if (enabled) {
      fastModeUserOverrideRef.current = true;
      setFastModeState(false);
    }
  }, []);

  // Sync model from agent detail
  useEffect(() => {
    if (agentDetail?.model) setSelectedModel(agentDetail.model);
  }, [agentDetail?.model]);

  const handleSendMessage = useCallback(
    async (attachments?: FilePointer[]) => {
      const trimmed = messageInput.trim();
      if (!trimmed && (!attachments || attachments.length === 0)) return;

      if (!selectedAgentId) {
        amplitude.track('goal_submitted', {
          goal: messageInput,
          model: selectedModel,
          has_attachments: attachments && attachments.length > 0,
        });
      }

      if (!canSubmitGoals) {
        pendingSubmitRef.current = true;
        setLoginModalOpen(true);
        toast({ title: 'Authentication required', description: 'Please log in to continue' });
        return;
      }

      try {
        setIsSendingMessage(true);

        if (!selectedAgentId) {
          const agentId = crypto.randomUUID();
          const submittedGoal = messageInput;
          setCurrentView('agents');
          stagePendingAgentCreation({
            agentId,
            goal: submittedGoal,
            model: selectedModel,
            source: clientSource as 'WEB' | 'MAC_APP',
            priceLimitCents: pendingPriceLimitCents,
          });
          setMessageInput('');
          setIsLoadingNetwork(true);
          try {
            const newAgent = await createAgent({
              agent_id: agentId,
              goal: submittedGoal,
              model: selectedModel,
              source: clientSource as 'WEB' | 'MAC_APP',
              attachments: attachments && attachments.length > 0 ? attachments : undefined,
              price_limit_cents: pendingPriceLimitCents,
              ...(userCanUseFastMode ? { fast_mode_cache_enabled: fastMode } : {}),
              ...(userCanUseSimulator
                ? { world_model_mode: simulatorMode ? 'simulate' : 'real' }
                : {}),
            });
            if (newAgent.agent_id !== agentId) {
              throw new Error('Created agent ID did not match the requested agent ID');
            }
            await reconcilePendingAgentCreation(agentId);
            void loadAgents();
          } catch (error) {
            if (rollbackPendingAgentCreation(agentId)) setMessageInput(submittedGoal);
            throw error;
          }
          toast({
            title: 'Agent created',
            description: 'Your new agent has been created and is starting',
          });
          return;
        }

        const responded = await checkAndRespondToAttention(selectedAgentId, messageInput);
        if (responded) {
          toast({
            title: 'Response sent',
            description: 'The agent will continue with your response',
          });
          setMessageInput('');
          return;
        }

        if (agentDetail?.status === 'PAUSED') {
          await resumeAgent(selectedAgentId);
          toast({
            title: 'Agent resuming',
            description: 'The agent will continue with your message',
          });
        }

        await postMessage(selectedAgentId, messageInput, attachments);
        setMessageInput('');
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : '';
        if (msg === 'Not authenticated' || msg.includes('401') || msg.includes('Unauthorized')) {
          setLoginModalOpen(true);
          toast({ title: 'Authentication required', description: 'Please log in to continue' });
        } else {
          toast({
            title: 'Error',
            description: selectedAgentId ? 'Failed to send message' : 'Failed to create agent',
            variant: 'destructive',
          });
        }
      } finally {
        setIsSendingMessage(false);
      }
    },
    [
      messageInput,
      selectedAgentId,
      selectedModel,
      fastMode,
      simulatorMode,
      canSubmitGoals,
      clientSource,
      pendingPriceLimitCents,
      agentDetail,
      userCanUseFastMode,
      userCanUseSimulator,
      loadAgents,
      setCurrentView,
      setLoginModalOpen,
      setIsLoadingNetwork,
      stagePendingAgentCreation,
      reconcilePendingAgentCreation,
      rollbackPendingAgentCreation,
      toast,
    ],
  );

  // Auto-submit after login
  useEffect(() => {
    if (!isFullySignedIn) {
      autoSubmitRef.current = false;
      return;
    }
    if (!pendingSubmitRef.current || !messageInputRef.current.trim()) return;
    if (isSendingMessage || autoSubmitRef.current) return;

    pendingSubmitRef.current = false;
    autoSubmitRef.current = true;
    void handleSendMessage()
      .catch((e) => console.error('[Auth] Auto-submit failed', e))
      .finally(() => {
        autoSubmitRef.current = false;
      });
  }, [isFullySignedIn, isSendingMessage, handleSendMessage]);

  return {
    messageInput,
    setMessageInput,
    isSendingMessage,
    setIsSendingMessage,
    selectedModel,
    setSelectedModel,
    pendingPriceLimitCents,
    setPendingPriceLimitCents,
    fastMode,
    setFastMode,
    simulatorMode,
    setSimulatorMode,
    handleSendMessage,
  };
}
