import { TerminalHeader } from './TerminalHeader';
import type { TerminalLayoutProps } from './terminalLayoutState';
import { useTerminalLogoutAction } from '../hooks/useTerminalLogoutAction';

/** The header row; Back on mobile returns to the open agent's parent when it has one. */
export function TerminalHeaderSection({
  agents,
  drip,
}: Pick<TerminalLayoutProps, 'agents' | 'drip'>) {
  const detail = agents.agentDetail;
  const onLogout = useTerminalLogoutAction(agents.handleLogout);
  return (
    <TerminalHeader
      onCreateNewAgent={agents.handleCreateNewAgent}
      onSelectAgent={agents.handleSelectAgent}
      onLoginClick={agents.handleLoginClick}
      onLogout={onLogout}
      isSignedIn={agents.isFullySignedIn}
      clientSource={agents.clientSource}
      agents={agents.agents}
      isLoadingAgents={agents.isLoadingAgents}
      hasLoadedAgents={agents.hasLoadedAgents}
      selectedAgentId={agents.selectedAgentId}
      selectedAgentParentId={
        detail?.agent_id === agents.selectedAgentId ? detail?.parent_agent_id : null
      }
      onRefreshAgents={agents.loadAgents}
      dripStyles={drip.dripStyles}
      blur={drip.blur}
      backgroundColors={drip.backgroundColors}
      borderColor={drip.borderColor}
      shadowIntensity={drip.shadowIntensity}
    />
  );
}
