/**
 * STATE MACHINE: selected owner's coding session -> breadcrumb + conversation.
 * Loaded matching owner -> ancestor / owner / resolved session title.
 * Owner click -> close only; another ancestor -> close then select that agent.
 * Owner loading -> conversation without a stale owner breadcrumb.
 */
import { cloneElement, type ReactElement, type ReactNode } from 'react';
import type { AgentSlice, DripSlice } from '../types';
import { BlurOverlay } from './ChatScrollArea';
import { SubAgentBreadcrumb } from './SubAgentBreadcrumb';

export function AgentCodeConversation({
  agents,
  drip,
  ownerAgentId,
  onClose,
  children,
}: {
  agents: AgentSlice;
  drip: DripSlice;
  ownerAgentId: string;
  onClose?: () => void;
  children: ReactElement<{ navigation?: (title: string) => ReactNode; backdrop?: ReactNode }>;
}) {
  const owner = agents.agentDetail?.agent_id === ownerAgentId ? agents.agentDetail : null;
  return cloneElement(children, {
    navigation: owner
      ? (title) => (
          <SubAgentBreadcrumb
            ancestors={agents.ancestors}
            agentDetail={owner}
            codeAgentTitle={title}
            onSelectAgent={(id) => {
              onClose?.();
              if (id !== agents.selectedAgentId) agents.handleSelectAgent(id);
            }}
            dripStyles={drip.dripStyles}
            blur={drip.blur}
          />
        )
      : undefined,
    backdrop: <BlurOverlay selectedAgentId={agents.selectedAgentId} {...drip} />,
  });
}
