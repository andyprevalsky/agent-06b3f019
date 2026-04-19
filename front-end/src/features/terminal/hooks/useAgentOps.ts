/**
 * Terminal feature — composed agent actions + messaging hook.
 *
 * Groups useAgentActions and useMessageSending so the top-level
 * composition hook can wire them with a single call.
 */

import type { useAuth } from '@/features/auth';
import type { useAgentContext } from '@/features/agent-context';

import type { TerminalView } from '../types';

import { useAgentActions } from './useAgentActions';
import { useMessageSending } from './useMessageSending';
import type { useAgentList } from './useAgentList';
import type { useLoadingNetwork } from './useLoadingNetwork';

export interface UseAgentOpsArgs {
  auth: ReturnType<typeof useAuth>;
  canSubmitGoals: boolean;
  clientSource: string;
  ctx: ReturnType<typeof useAgentContext>;
  agentList: ReturnType<typeof useAgentList>;
  loading: ReturnType<typeof useLoadingNetwork>;
  setCurrentView: (v: TerminalView) => void;
  setLoginModalOpen: (v: boolean) => void;
}

export function useAgentOps({
  auth,
  canSubmitGoals,
  clientSource,
  ctx,
  agentList,
  loading,
  setCurrentView,
  setLoginModalOpen,
}: UseAgentOpsArgs) {
  const actions = useAgentActions({
    selectedAgentId: ctx.selectedAgentId,
    agentDetail: ctx.agent,
    setAgentDetail: ctx.setAgent,
    setMessages: ctx.setMessages,
    setSelectedModel: () => {},
    setSelectedAgentIdContext: ctx.setSelectedAgentId,
    setCurrentView,
    clientSource,
    loadAgents: agentList.loadAgents,
  });

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

  return { actions, messaging };
}
