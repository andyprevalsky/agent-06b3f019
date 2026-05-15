/**
 * Terminal feature — message sending hook.
 *
 * Handles message input, creating agents from goals,
 * sending messages to existing agents, and auto-submit after login.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import * as amplitude from '@amplitude/analytics-browser';

import { useToast } from '@/hooks/use-toast';

import { DEFAULT_MODEL, DEFAULT_PRICE_LIMIT_CENTS } from '../config';
import { createAgent, postMessage, resumeAgent, checkAndRespondToAttention } from '../api';
import type { FilePointer, AgentDetail, TerminalView } from '../types';

interface UseMessageSendingArgs {
  selectedAgentId: string | null;
  agentDetail: AgentDetail | null;
  canSubmitGoals: boolean;
  isFullySignedIn: boolean;
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

  const messageInputRef = useRef<string>('');
  const pendingSubmitRef = useRef(false);
  const autoSubmitRef = useRef(false);

  useEffect(() => {
    messageInputRef.current = messageInput;
  }, [messageInput]);

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
      canSubmitGoals,
      clientSource,
      pendingPriceLimitCents,
      agentDetail,
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
    handleSendMessage,
  };
}
