/**
 * STATE MACHINE: TerminalModals
 *
 * Renders all modal dialogs for the terminal feature.
 * Each modal is controlled by boolean open/close state from parent.
 * No internal business logic — purely presentation wiring.
 */

import { CreateAgentModal } from '@/features/terminal-component-group';
import SubscriptionModal from '@/components/SubscriptionModal';
import { CostLimitModal } from '@/features/terminal-component-group';
import { PhoneAuthModal } from '@/features/auth';
import type { AgentDetail, CreateAgentPayload } from '@/lib/api';

interface TerminalModalsProps {
  agents: {
    createModalOpen: boolean;
    setCreateModalOpen: (v: boolean) => void;
    loginModalOpen: boolean;
    setLoginModalOpen: (v: boolean) => void;
    showCreditModal: boolean;
    setShowCreditModal: (v: boolean) => void;
    showCostLimitModal: boolean;
    setShowCostLimitModal: (v: boolean) => void;
    handleCreateAgent: (data: CreateAgentPayload) => Promise<void>;
    refreshAuthState: (reason?: string) => Promise<void>;
    isAnonymous: boolean;
    authUser: { id: string } | null;
    agentDetail: AgentDetail | null;
    selectedAgentId: string | null;
    refreshAgentDetail: (id: string) => Promise<void>;
    cleanupAgentState: () => void;
    loadAgents: () => Promise<void>;
  };
  drip: { blur: number };
}

export function TerminalModals({ agents }: TerminalModalsProps) {
  return (
    <>
      <CreateAgentModal
        open={agents.createModalOpen}
        onClose={() => agents.setCreateModalOpen(false)}
        onSubmit={agents.handleCreateAgent}
      />

      <PhoneAuthModal
        open={agents.loginModalOpen}
        onOpenChange={agents.setLoginModalOpen}
        onAuthComplete={(reason) => {
          void agents.refreshAuthState(reason);
        }}
        anonymousUserId={agents.isAnonymous ? agents.authUser?.id : undefined}
      />

      <SubscriptionModal
        open={agents.showCreditModal}
        onOpenChange={agents.setShowCreditModal}
        currentTier={null}
        upgradeOptions={[]}
        remaining={0}
      />

      <CostLimitModal
        open={agents.showCostLimitModal}
        onOpenChange={agents.setShowCostLimitModal}
        agentId={agents.agentDetail?.agent_id || ''}
        currentLimitCents={agents.agentDetail?.price_limit_cents || 100}
        currentCostCents={agents.agentDetail?.tree_cost_cents || 0}
        onIncrease={() => {
          if (agents.selectedAgentId) {
            void agents.refreshAgentDetail(agents.selectedAgentId);
          }
        }}
        onDelete={() => {
          agents.cleanupAgentState();
          void agents.loadAgents();
        }}
      />
    </>
  );
}
