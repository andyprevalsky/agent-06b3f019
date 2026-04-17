/**
 * Terminal feature — composed agent management hook.
 *
 * Composes focused sub-hooks into a single return value
 * consumed by TerminalContent. Each sub-hook handles a
 * specific concern (list, actions, messaging, auth).
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as amplitude from '@amplitude/analytics-browser';

import { useAuth } from '@/features/auth';
import { signOut, clearStoredSession } from '@/lib/supabase';
import { getClientSource } from '@/lib/clientSource';
import { useAgentContext } from '@/features/agent-context';
import { useToast } from '@/hooks/use-toast';
import { QUICK_QUERY_EVENT, type QuickLauncherPayload } from '@/lib/quickQuery';

import { fetchAncestors as fetchAncestorsAPI } from '../api';
import type { AncestorNode, TerminalView } from '../types';

import { useAgentList } from './useAgentList';
import { useAgentActions } from './useAgentActions';
import { useMessageSending } from './useMessageSending';
import { useLoadingNetwork } from './useLoadingNetwork';

export function useTerminalAgents(
  _currentView: TerminalView,
  setCurrentView: (view: TerminalView) => void,
  resetAnimationState: () => void,
) {
  const { toast } = useToast();
  const auth = useAuth();
  const user = auth.isFullySignedIn ? auth.user : null;
  const canSubmitGoals = auth.isAuthenticated;
  const clientSource = useMemo(() => getClientSource(), []);

  const ctx = useAgentContext();
  const agentList = useAgentList(canSubmitGoals);

  // Modal state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [showCreditModal, setShowCreditModal] = useState(false);
  const [showCostLimitModal, setShowCostLimitModal] = useState(false);

  // Loading network
  const loading = useLoadingNetwork(ctx.selectedAgentId, ctx.isLoadingAgent, ctx.agent?.status);

  // Ancestors
  const [ancestors, setAncestors] = useState<AncestorNode[]>([]);
  useEffect(() => {
    if (!ctx.selectedAgentId) {
      setAncestors([]);
      return;
    }
    fetchAncestorsAPI(ctx.selectedAgentId)
      .then(setAncestors)
      .catch(() => setAncestors([]));
  }, [ctx.selectedAgentId]);

  // Amplitude
  useEffect(() => {
    if (!auth.isAuthenticated || !auth.user) return;
    amplitude.setUserId(auth.user.phone || auth.user.id);
  }, [auth.isAuthenticated, auth.user]);

  // Agent actions
  const actions = useAgentActions({
    selectedAgentId: ctx.selectedAgentId,
    agentDetail: ctx.agent,
    setAgentDetail: ctx.setAgent,
    setMessages: ctx.setMessages,
    setSelectedModel: () => {}, // handled by messaging hook
    setSelectedAgentIdContext: ctx.setSelectedAgentId,
    setCurrentView,
    clientSource,
    loadAgents: agentList.loadAgents,
  });

  // Messaging
  const messaging = useMessageSending({
    selectedAgentId: ctx.selectedAgentId,
    agentDetail: ctx.agent,
    canSubmitGoals,
    isFullySignedIn: auth.isFullySignedIn,
    clientSource,
    setSelectedAgentIdContext: ctx.setSelectedAgentId,
    setCurrentView,
    setLoginModalOpen,
    setIsLoadingNetwork: loading.setIsLoadingNetwork,
    loadAgents: agentList.loadAgents,
  });

  // Sync model from agent detail (override messaging default)
  const isInitialLoadRef = useRef(false);
  useEffect(() => {
    if (ctx.agent?.model) {
      messaging.setSelectedModel(ctx.agent.model);
      isInitialLoadRef.current = true;
    }
  }, [ctx.agent?.model, messaging.setSelectedModel]);

  // Cleanup
  const cleanupAgentState = useCallback(() => {
    ctx.setSelectedAgentId(null);
    isInitialLoadRef.current = false;
    messaging.setIsSendingMessage(false);
    messaging.setMessageInput('');
  }, [ctx.setSelectedAgentId, messaging]);

  const handleCreateNewAgent = useCallback(() => {
    cleanupAgentState();
    resetAnimationState();
    setCurrentView('agents');
  }, [cleanupAgentState, resetAnimationState, setCurrentView]);

  // Logout
  const handleLogout = useCallback(async () => {
    try {
      await signOut();
      clearStoredSession();
      await auth.refreshAuthState('logout');
      agentList.setAgents([]);
      ctx.setSelectedAgentId(null);
      messaging.setMessageInput('');
      setCurrentView('agents');
      amplitude.reset();
    } catch (err: unknown) {
      console.error('[Auth] Logout failed', err);
      toast({ title: 'Error', description: 'Failed to log out', variant: 'destructive' });
    }
  }, [auth, agentList, ctx, messaging, setCurrentView, toast]);

  const handleLoginClick = useCallback(() => setLoginModalOpen(true), []);

  // Quick query
  useQuickQueryListener({
    selectedModel: messaging.selectedModel,
    canSubmitGoals,
    clientSource,
    pendingPriceLimitCents: messaging.pendingPriceLimitCents,
    setCurrentView,
    setMessageInput: messaging.setMessageInput,
    setIsSendingMessage: messaging.setIsSendingMessage,
    setIsLoadingNetwork: loading.setIsLoadingNetwork,
    setLoginModalOpen,
    setSelectedAgentIdContext: ctx.setSelectedAgentId,
    loadAgents: agentList.loadAgents,
    toast,
  });

  return {
    user,
    authUser: auth.user,
    isFullySignedIn: auth.isFullySignedIn,
    isAuthenticated: auth.isAuthenticated,
    isAnonymous: auth.isAnonymous,
    refreshAuthState: auth.refreshAuthState,
    realtimeReady: auth.realtimeReady,
    canSubmitGoals,
    agentDetail: ctx.agent,
    selectedAgentId: ctx.selectedAgentId,
    messages: ctx.messages,
    contextStreamingBubbles: ctx.streamingBubbles,
    contextStreamingPlan: ctx.streamingPlan,
    contextStreamingAttention: ctx.streamingAttention,
    isLoadingAgent: ctx.isLoadingAgent,
    forceResubscribeContext: ctx.forceResubscribe,
    isChatMode: ctx.isChatMode,
    agents: agentList.agents,
    isLoadingAgents: agentList.isLoadingAgents,
    resumingAgentId: actions.resumingAgentId,
    isPausing: actions.isPausing,
    ancestors,
    clientSource,
    messageInput: messaging.messageInput,
    setMessageInput: messaging.setMessageInput,
    isSendingMessage: messaging.isSendingMessage,
    selectedModel: messaging.selectedModel,
    setSelectedModel: messaging.setSelectedModel,
    pendingPriceLimitCents: messaging.pendingPriceLimitCents,
    setPendingPriceLimitCents: messaging.setPendingPriceLimitCents,
    createModalOpen,
    setCreateModalOpen,
    loginModalOpen,
    setLoginModalOpen,
    showCreditModal,
    setShowCreditModal,
    showCostLimitModal,
    setShowCostLimitModal,
    isLoadingNetwork: loading.isLoadingNetwork,
    loadingDots: loading.loadingDots,
    isInitialLoadRef,
    loadAgents: agentList.loadAgents,
    refreshAgentDetail: actions.refreshAgentDetail,
    cleanupAgentState,
    handleSelectAgent: actions.handleSelectAgent,
    handleCreateAgent: actions.handleCreateAgent,
    handleResumeAgent: actions.handleResumeAgent,
    handlePauseAgent: actions.handlePauseAgent,
    handleSendMessage: messaging.handleSendMessage,
    handleLogout,
    handleLoginClick,
    handleCreateNewAgent,
    handleSubmitFeedback: actions.handleSubmitFeedback,
    resetAnimationState,
  };
}

// ── Quick query listener (separated to keep main hook small) ────────────

function useQuickQueryListener(deps: {
  selectedModel: string;
  canSubmitGoals: boolean;
  clientSource: string;
  pendingPriceLimitCents: number;
  setCurrentView: (v: TerminalView) => void;
  setMessageInput: (v: string) => void;
  setIsSendingMessage: (v: boolean) => void;
  setIsLoadingNetwork: (v: boolean) => void;
  setLoginModalOpen: (v: boolean) => void;
  setSelectedAgentIdContext: (id: string | null) => void;
  loadAgents: () => Promise<void>;
  toast: ReturnType<typeof useToast>['toast'];
}) {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<QuickLauncherPayload>).detail;
      if (!detail?.query?.trim()) return;
      void handleQuickQuery(depsRef.current, detail.query.trim());
    };
    window.addEventListener(QUICK_QUERY_EVENT, handler as EventListener);
    return () => window.removeEventListener(QUICK_QUERY_EVENT, handler as EventListener);
  }, []);
}

async function handleQuickQuery(
  d: {
    selectedModel: string;
    canSubmitGoals: boolean;
    clientSource: string;
    pendingPriceLimitCents: number;
    setCurrentView: (v: TerminalView) => void;
    setMessageInput: (v: string) => void;
    setIsSendingMessage: (v: boolean) => void;
    setIsLoadingNetwork: (v: boolean) => void;
    setLoginModalOpen: (v: boolean) => void;
    setSelectedAgentIdContext: (id: string | null) => void;
    loadAgents: () => Promise<void>;
    toast: ReturnType<typeof useToast>['toast'];
  },
  trimmed: string,
) {
  d.setCurrentView('agents');
  d.setMessageInput(trimmed);
  amplitude.track('goal_submitted', {
    goal: trimmed,
    model: d.selectedModel,
    source: 'quick_launcher',
  });

  if (!d.canSubmitGoals) {
    d.setLoginModalOpen(true);
    d.toast({ title: 'Authentication required', description: 'Please log in to continue' });
    return;
  }

  try {
    d.setIsSendingMessage(true);
    d.setIsLoadingNetwork(true);
    const newAgent = await createAgent({
      goal: trimmed,
      model: d.selectedModel,
      source: d.clientSource,
      price_limit_cents: d.pendingPriceLimitCents,
    });
    await d.loadAgents();
    d.setCurrentView('agents');
    d.setSelectedAgentIdContext(newAgent.agent_id);
    d.setMessageInput('');
    d.toast({
      title: 'Agent created',
      description: 'Your new agent has been created and is starting',
    });
  } catch (error: unknown) {
    d.toast({
      title: 'Error',
      description: error instanceof Error ? error.message : 'Failed to send message',
      variant: 'destructive',
    });
  } finally {
    d.setIsSendingMessage(false);
  }
}
