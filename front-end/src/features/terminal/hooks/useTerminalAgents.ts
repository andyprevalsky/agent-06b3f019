/**
 * Terminal feature — composed agent management hook.
 *
 * Composes focused sub-hooks into a single return value
 * consumed by TerminalContent. Each sub-hook handles a
 * specific concern (list, actions, messaging, auth, modals).
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useAuth } from '@/features/auth';
import { getClientSource } from '@/lib/clientSource';
import { useAgentContext } from '@/features/agent-context';
import { useToast } from '@/hooks/use-toast';

import type { TerminalView } from '../types';

import { useAgentList } from './useAgentList';
import type { useAgentActions } from './useAgentActions';
import type { useMessageSending } from './useMessageSending';
import { useLoadingNetwork } from './useLoadingNetwork';
import { useAncestors } from './useAncestors';
import { useTerminalAuth } from './useTerminalAuth';
import { useTerminalModals } from './useTerminalModals';
import { useAgentOps } from './useAgentOps';
import { useQuickQuery } from './useQuickQuery';

export function useTerminalAgents(
  _currentView: TerminalView,
  setCurrentView: (view: TerminalView) => void,
  resetAnimationState: () => void,
) {
  const { toast } = useToast();
  const auth = useAuth();
  const canSubmitGoals = auth.isAuthenticated;
  const clientSource = useMemo(() => getClientSource(), []);
  const ctx = useAgentContext();

  const agentList = useAgentList(canSubmitGoals);
  const modals = useTerminalModals();
  const loading = useLoadingNetwork(ctx.selectedAgentId, ctx.isLoadingAgent, ctx.agent?.status);
  const ancestors = useAncestors(ctx.selectedAgentId);

  const { actions, messaging } = useAgentOps({
    auth,
    canSubmitGoals,
    clientSource,
    ctx,
    agentList,
    loading,
    setCurrentView,
    setLoginModalOpen: modals.setLoginModalOpen,
  });

  const isInitialLoadRef = useRef(false);
  useEffect(() => {
    if (ctx.agent?.model) {
      messaging.setSelectedModel(ctx.agent.model);
      isInitialLoadRef.current = true;
    }
  }, [ctx.agent?.model, messaging.setSelectedModel]);

  const cleanupAgentState = useCallback(() => {
    ctx.setSelectedAgentId(null);
    isInitialLoadRef.current = false;
    messaging.setIsSendingMessage(false);
    messaging.setMessageInput('');
  }, [ctx.setSelectedAgentId, messaging]);

  const { handleLogout } = useTerminalAuth({
    auth,
    setAgents: agentList.setAgents,
    setSelectedAgentId: ctx.setSelectedAgentId,
    setMessageInput: messaging.setMessageInput,
    setCurrentView,
  });

  useQuickQuery({
    selectedModel: messaging.selectedModel,
    canSubmitGoals,
    clientSource,
    pendingPriceLimitCents: messaging.pendingPriceLimitCents,
    setCurrentView,
    setMessageInput: messaging.setMessageInput,
    setIsSendingMessage: messaging.setIsSendingMessage,
    setIsLoadingNetwork: loading.setIsLoadingNetwork,
    setLoginModalOpen: modals.setLoginModalOpen,
    setSelectedAgentIdContext: ctx.setSelectedAgentId,
    loadAgents: agentList.loadAgents,
    toast,
  });

  return buildReturn({
    auth,
    canSubmitGoals,
    clientSource,
    ctx,
    agentList,
    actions,
    messaging,
    loading,
    ancestors,
    modals,
    isInitialLoadRef,
    cleanupAgentState,
    handleLogout,
    resetAnimationState,
    setCurrentView,
  });
}

// ── Return-shape builder (keeps the main hook function short) ─────────────

type BuildArgs = {
  auth: ReturnType<typeof useAuth>;
  canSubmitGoals: boolean;
  clientSource: string;
  ctx: ReturnType<typeof useAgentContext>;
  agentList: ReturnType<typeof useAgentList>;
  actions: ReturnType<typeof useAgentActions>;
  messaging: ReturnType<typeof useMessageSending>;
  loading: ReturnType<typeof useLoadingNetwork>;
  ancestors: ReturnType<typeof useAncestors>;
  modals: ReturnType<typeof useTerminalModals>;
  isInitialLoadRef: React.MutableRefObject<boolean>;
  cleanupAgentState: () => void;
  handleLogout: () => Promise<void>;
  resetAnimationState: () => void;
  setCurrentView: (v: TerminalView) => void;
};

function buildReturn(a: BuildArgs) {
  const handleLoginClick = () => a.modals.setLoginModalOpen(true);
  const handleCreateNewAgent = () => {
    a.cleanupAgentState();
    a.resetAnimationState();
    a.setCurrentView('agents');
  };
  return {
    user: a.auth.isFullySignedIn ? a.auth.user : null,
    authUser: a.auth.user,
    isFullySignedIn: a.auth.isFullySignedIn,
    isAuthenticated: a.auth.isAuthenticated,
    isAnonymous: a.auth.isAnonymous,
    refreshAuthState: a.auth.refreshAuthState,
    realtimeReady: a.auth.realtimeReady,
    canSubmitGoals: a.canSubmitGoals,
    agentDetail: a.ctx.agent,
    selectedAgentId: a.ctx.selectedAgentId,
    messages: a.ctx.messages,
    contextStreamingBubbles: a.ctx.streamingBubbles,
    contextStreamingPlan: a.ctx.streamingPlan,
    contextStreamingAttention: a.ctx.streamingAttention,
    isLoadingAgent: a.ctx.isLoadingAgent,
    forceResubscribeContext: a.ctx.forceResubscribe,
    isChatMode: a.ctx.isChatMode,
    agents: a.agentList.agents,
    isLoadingAgents: a.agentList.isLoadingAgents,
    resumingAgentId: a.actions.resumingAgentId,
    isPausing: a.actions.isPausing,
    ancestors: a.ancestors,
    clientSource: a.clientSource,
    messageInput: a.messaging.messageInput,
    setMessageInput: a.messaging.setMessageInput,
    isSendingMessage: a.messaging.isSendingMessage,
    selectedModel: a.messaging.selectedModel,
    setSelectedModel: a.messaging.setSelectedModel,
    pendingPriceLimitCents: a.messaging.pendingPriceLimitCents,
    setPendingPriceLimitCents: a.messaging.setPendingPriceLimitCents,
    createModalOpen: a.modals.createModalOpen,
    setCreateModalOpen: a.modals.setCreateModalOpen,
    loginModalOpen: a.modals.loginModalOpen,
    setLoginModalOpen: a.modals.setLoginModalOpen,
    showCreditModal: a.modals.showCreditModal,
    setShowCreditModal: a.modals.setShowCreditModal,
    showCostLimitModal: a.modals.showCostLimitModal,
    setShowCostLimitModal: a.modals.setShowCostLimitModal,
    isLoadingNetwork: a.loading.isLoadingNetwork,
    loadingDots: a.loading.loadingDots,
    isInitialLoadRef: a.isInitialLoadRef,
    loadAgents: a.agentList.loadAgents,
    refreshAgentDetail: a.actions.refreshAgentDetail,
    cleanupAgentState: a.cleanupAgentState,
    handleSelectAgent: a.actions.handleSelectAgent,
    handleCreateAgent: a.actions.handleCreateAgent,
    handleResumeAgent: a.actions.handleResumeAgent,
    handlePauseAgent: a.actions.handlePauseAgent,
    handleSendMessage: a.messaging.handleSendMessage,
    handleLogout: a.handleLogout,
    handleLoginClick,
    handleCreateNewAgent,
    handleSubmitFeedback: a.actions.handleSubmitFeedback,
    resetAnimationState: a.resetAnimationState,
  };
}
