/**
 * STATE MACHINE: selected owner's coding session -> breadcrumb + conversation.
 * Loaded matching owner -> ancestor / owner / resolved session title.
 * Owner click -> close only; another ancestor -> close then select that agent.
 * Owner loading -> conversation without a stale owner breadcrumb.
 */
import { CodeAgentConversationView, useCodeAgentView } from '@/features/terminal-component-group';
import type { OpenCodeAgent } from '@/features/terminal-component-group/components/code-agent-view/codeAgentViewState';
import type { AgentSlice, DripSlice } from '../types';
import { BlurOverlay } from './ChatScrollArea';
import { SubAgentBreadcrumb } from './SubAgentBreadcrumb';

export function AgentCodeConversation({
  agents,
  drip,
  codeAgent,
  readOnlyMessage,
}: {
  agents: AgentSlice;
  drip: DripSlice;
  codeAgent: OpenCodeAgent;
  readOnlyMessage: string | null;
}) {
  const codeAgentView = useCodeAgentView();
  const owner = agents.agentDetail?.agent_id === codeAgent.ownerAgentId ? agents.agentDetail : null;
  return (
    <CodeAgentConversationView
      key={codeAgent.taskId}
      codeAgent={codeAgent}
      readOnlyMessage={readOnlyMessage}
      backdrop={<BlurOverlay selectedAgentId={agents.selectedAgentId} {...drip} />}
      navigation={
        owner
          ? (title) => (
              <SubAgentBreadcrumb
                ancestors={agents.ancestors}
                agentDetail={owner}
                codeAgentTitle={title}
                onSelectAgent={(id) => {
                  codeAgentView?.close();
                  if (id !== agents.selectedAgentId) agents.handleSelectAgent(id);
                }}
                dripStyles={drip.dripStyles}
                blur={drip.blur}
              />
            )
          : undefined
      }
    />
  );
}
