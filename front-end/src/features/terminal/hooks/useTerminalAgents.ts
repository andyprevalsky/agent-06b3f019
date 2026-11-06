/**
 * Terminal feature — composed agent management hook.
 *
 * Composes focused sub-hooks into a single return value
 * consumed by TerminalContent. Each sub-hook handles a
 * specific concern (list, actions, messaging, auth, modals).
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useAuth } from '@/features/auth';
import { readQueryPreferences } from '@/lib/queryPreferences';
import { getClientSource } from '@/lib/clientSource';
import { isRoseDesktopUser } from '@/lib/roseDesktop';
import { useAgentContext } from '@/features/agent-context';
import { useToast } from '@/hooks/use-toast';

import type { TerminalView } from '../types';
import { DEFAULT_MODEL, ROSE_DESKTOP_DEFAULT_MODEL } from '../config';

import { useAgentList } from './useAgentList';
import type { useAgentActions } from './useAgentActions';
import type { useMessageSending } from './useMessageSending';
import { useLoadingNetwork } from './useLoadingNetwork';
import { useAncestors } from './useAncestors';
import { useTerminalAuth } from './useTerminalAuth';
import { useTerminalModals } from './useTerminalModals';
import { useAgentOps } from './useAgentOps';
import { useQuickQuery } from './useQuickQuery';

export function overlaySelectedAgentTitle(
  agents: ReturnType<typeof useAgentList>['agents'],
  selectedAgent: ReturnType<typeof useAgentContext>['agent'],
) {
  if (!selectedAgent) return agents;
  return agents.map((agent) =>
    agent.agent_id === selectedAgent.agent_id && agent.title !== selectedAgent.title
      ? { ...agent, title: selectedAgent.title }
      : agent,
  );
}

export function useSelectedAgentModel(
  selectedAgentId: string | null,
  modelOwnerId: string | undefined,
  model: string | undefined,
  setSelectedModel: (model: string) => void,
  isInitialLoadRef: React.MutableRefObject<boolean>,
  defaultModel: string = DEFAULT_MODEL,
) {
  useEffect(() => {
    setSelectedModel(modelOwnerId === selectedAgentId ? (model ?? defaultModel) : defaultModel);
    isInitialLoadRef.current = true;
  }, [defaultModel, isInitialLoadRef, model, modelOwnerId, selectedAgentId, setSelectedModel]);
}

/** New-agent model default: rose-flash for signed-in Rose Desktop accounts. */
export function defaultModelForAccount(auth: {
  isAnonymous: boolean;
  isFullySignedIn: boolean;
  user: { id?: string } | null;
}): string {
  const user = auth.isFullySignedIn ? auth.user : null;
  const saved = readQueryPreferences(user?.id).model;
  if (saved) return saved;
  return !auth.isAnonymous && isRoseDesktopUser(user) ? ROSE_DESKTOP_DEFAULT_MODEL : DEFAULT_MODEL;
}

function useContextSelectedAgentModel(
  ctx: ReturnType<typeof useAgentContext>,
  messaging: ReturnType<typeof useMessageSending>,
  isInitialLoadRef: React.MutableRefObject<boolean>,
  defaultModel: string,
) {
  useSelectedAgentModel(
    ctx.selectedAgentId,
    ctx.agent?.agent_id,
    ctx.agent?.model,
    messaging.syncSelectedModel,
    isInitialLoadRef,
    defaultModel,
  );
}

export function useTerminalAgents(
  _currentView: TerminalView,
  setCurrentView: (view: TerminalView) => void,
  resetAnimationState: () => void,
) {
  const { toast } = useToast();
  const auth = useAuth();
  const canSubmitGoals = auth.isFullySignedIn;
  const clientSource = useMemo(() => getClientSource(), []);
  const ctx = useAgentContext();

  const agentList = useAgentList(canSubmitGoals);
  const modals = useTerminalModals();
  const loading = useLoadingNetwork(ctx.selectedAgentId, ctx.isLoadingAgent, ctx.agent?.status);
  const ancestors = useAncestors(
    ctx.selectedAgentId,
    ctx.agent?.parent_agent_id,
    ctx.agent?.parent_goal,
  );

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
  const { setIsSendingMessage, setMessageInput } = messaging;
  const { setSelectedAgentId } = ctx;
  useContextSelectedAgentModel(ctx, messaging, isInitialLoadRef, defaultModelForAccount(auth));

  const cleanupAgentState = useCallback(() => {
    setSelectedAgentId(null);
    isInitialLoadRef.current = false;
    setIsSendingMessage(false);
    setMessageInput('');
  }, [setIsSendingMessage, setMessageInput, setSelectedAgentId]);

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
    authReady: !auth.loading,
    messageInput: messaging.messageInput,
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
  clientSource: ReturnType<typeof getClientSource>;
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

function buildAuthModalHandlers(modals: ReturnType<typeof useTerminalModals>) {
  const handleLoginClick = () => {
    modals.setLoginModalCollectName(false);
    modals.setLoginModalOpen(true);
  };
  const handleJoinWaitlist = () => {
    modals.setLoginModalTitle('Join the Waitlist');
    modals.setLoginModalCollectName(true);
    modals.setLoginModalOpen(true);
  };
  return { handleLoginClick, handleJoinWaitlist };
}

/** New-agent entry points; each makes the next goal create a fresh agent. */
function buildNewAgentHandlers({
  cleanupAgentState,
  resetAnimationState,
  setCurrentView,
  messaging: { setNewAgentProjectId, setNewAgentFolderId },
}: BuildArgs) {
  const openNewAgent = (projectId: string | null, folderId: string | null = null) => {
    cleanupAgentState();
    resetAnimationState();
    setCurrentView('agents');
    setNewAgentProjectId(projectId);
    setNewAgentFolderId(folderId);
  };
  return {
    /** New Super Agent: the next goal creates a Home agent. */
    handleCreateNewAgent: () => openNewAgent(null),
    /** A project's "+" (Rose Desktop): the next goal creates the agent in that project. */
    handleCreateNewAgentInProject: (project: { id: string }, folderId?: string | null) =>
      openNewAgent(project.id, folderId),
  };
}

function buildReturn(a: BuildArgs) {
  const { handleLoginClick, handleJoinWaitlist } = buildAuthModalHandlers(a.modals);
  const newAgent = buildNewAgentHandlers(a);
  return {
    user: a.auth.isFullySignedIn ? a.auth.user : null,
    authUser: a.auth.user,
    inviteRequired: a.auth.inviteRequired,
    isFullySignedIn: a.auth.isFullySignedIn,
    isAuthenticated: a.auth.isAuthenticated,
    isAnonymous: a.auth.isAnonymous,
    refreshAuthState: a.auth.refreshAuthState,
    realtimeReady: a.auth.realtimeReady,
    canSubmitGoals: a.canSubmitGoals,
    agentDetail: a.ctx.agent,
    inspectionContext: a.ctx.inspectionContext,
    selectedAgentId: a.ctx.selectedAgentId,
    messages: a.ctx.messages,
    contextStreamingBubbles: a.ctx.streamingBubbles,
    contextStreamingPlan: a.ctx.streamingPlan,
    contextStreamingAttention: a.ctx.streamingAttention,
    isLoadingAgent: a.ctx.isLoadingAgent,
    forceResubscribeContext: a.ctx.forceResubscribe,
    isChatMode: a.ctx.isChatMode,
    agents: overlaySelectedAgentTitle(a.agentList.agents, a.ctx.agent),
    isLoadingAgents: a.agentList.isLoadingAgents,
    hasLoadedAgents: a.agentList.hasLoadedAgents,
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
    fastMode: a.messaging.fastMode,
    setFastMode: a.messaging.setFastMode,
    simulatorMode: a.messaging.simulatorMode,
    setSimulatorMode: a.messaging.setSimulatorMode,
    createModalOpen: a.modals.createModalOpen,
    setCreateModalOpen: a.modals.setCreateModalOpen,
    loginModalOpen: a.modals.loginModalOpen,
    setLoginModalOpen: a.modals.setLoginModalOpen,
    loginModalTitle: a.modals.loginModalTitle,
    setLoginModalTitle: a.modals.setLoginModalTitle,
    loginModalCollectName: a.modals.loginModalCollectName,
    setLoginModalCollectName: a.modals.setLoginModalCollectName,
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
    handleJoinWaitlist,
    ...newAgent,
    newAgentProjectId: a.messaging.newAgentProjectId,
    newAgentFolderId: a.messaging.newAgentFolderId,
    handleSubmitFeedback: a.actions.handleSubmitFeedback,
    resetAnimationState: a.resetAnimationState,
  };
}
