/**
 * Terminal feature — message sending hook.
 *
 * Handles message input, creating agents from goals,
 * sending messages to existing agents, and auto-submit after login.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import * as amplitude from '@amplitude/analytics-browser';

import { useToast } from '@/hooks/use-toast';
import { DEFAULT_FAST_MODE_USER_IDS, FAST_MODE_USER_IDS } from '@/lib/fastModeAccounts';
import { SIMULATOR_USER_IDS } from '@/lib/simulatorAccounts';

import { DEFAULT_MODEL, DEFAULT_PRICE_LIMIT_CENTS } from '../config';
import { createAgent, postMessage, resumeAgent, checkAndRespondToAttention } from '../api';
import type { FilePointer, AgentDetail, TerminalView } from '../types';

interface UseMessageSendingArgs {
  selectedAgentId: string | null;
  agentDetail: AgentDetail | null;
  canSubmitGoals: boolean;
  isFullySignedIn: boolean;
  userId?: string | null;
  clientSource: string;
  setSelectedAgentIdContext: (id: string | null) => void;
  setCurrentView: (v: TerminalView) => void;
  setLoginModalOpen: (v: boolean) => void;
  setIsLoadingNetwork: (v: boolean) => void;
  loadAgents: () => Promise<void>;
}

export function useMessageSending({
  selectedAgentId,
  agentDetail,
  canSubmitGoals,
  isFullySignedIn,
  userId,
  clientSource,
  setSelectedAgentIdContext,
  setCurrentView,
  setLoginModalOpen,
  setIsLoadingNetwork,
  loadAgents,
}: UseMessageSendingArgs) {
  const { toast } = useToast();

  const [messageInput, setMessageInput] = useState(() => {
    const prefill = localStorage.getItem('onboarding_prefill_query');
    if (prefill) {
      localStorage.removeItem('onboarding_prefill_query');
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
  }, []);

  useEffect(() => {
    if (!userCanUseSimulator) setSimulatorModeState(false);
  }, [userCanUseSimulator]);

  const setSimulatorMode = useCallback((enabled: boolean) => {
    setSimulatorModeState(enabled);
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
          setIsLoadingNetwork(true);
          const newAgent = await createAgent({
            goal: messageInput,
            model: selectedModel,
            source: clientSource,
            attachments: attachments && attachments.length > 0 ? attachments : undefined,
            price_limit_cents: pendingPriceLimitCents,
            ...(userCanUseFastMode ? { fast_mode_cache_enabled: fastMode } : {}),
          });
          await loadAgents();
          setCurrentView('agents');
          setSelectedAgentIdContext(newAgent.agent_id);
          setMessageInput('');
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
      canSubmitGoals,
      clientSource,
      pendingPriceLimitCents,
      agentDetail,
      userCanUseFastMode,
      loadAgents,
      setCurrentView,
      setSelectedAgentIdContext,
      setLoginModalOpen,
      setIsLoadingNetwork,
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
