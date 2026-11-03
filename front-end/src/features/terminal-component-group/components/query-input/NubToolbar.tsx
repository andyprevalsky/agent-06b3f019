/**
 * STATE MACHINE: NubToolbar (items on the Rose Desktop query-box tab)
 *
 * Stateless layout; each item owns its own state (lock toggle, popovers,
 * price-limit edit, settings dialog, info menu). Order, left → right:
 *
 *   lock · context files* · budget · context % · settings · report bug* · info
 *   (* account-gated: context files = dev/admin desktop; report bug = admin)
 *
 * Report bug is its own item (not inside Agent Settings), and the settings
 * panel opened from this drawer has no Delete Agent.
 *
 * Every item is a bare white 12px icon or 10px mono text with an instant
 * tooltip (NubTip). Not here: the Rose toolset (wrench) and the world
 * simulator stay pinned top-left inside the box (PinnedTools), and speed sits
 * next to the model selector. Replaces the stock in-box TopBar row for Rose
 * Desktop accounts only.
 */

import WriteLockToggle from '../WriteLockToggle';
import TestPromptsSelector from '../TestPromptsSelector';
import AgentSettingsDialog from '../AgentSettingsDialog';
import ReportBugDialog from '../ReportBugDialog';
import { CostIndicator } from './CostIndicator';
import { ContextMeter } from './ContextMeter';
import { QueryInfoMenu } from './QueryInfoMenu';
import type { TopBarProps } from './TopBar';

export function NubToolbar(props: TopBarProps) {
  const { agentDetail } = props;
  return (
    <>
      <WriteLockToggle
        variant="nub"
        agentId={agentDetail?.agent_id}
        writeLockEnabled={agentDetail?.write_lock_enabled ?? true}
        onUpdate={props.onAgentUpdate}
      />
      {props.showTestPrompts && (
        <TestPromptsSelector
          variant="nub"
          onSelectPrompt={props.onSelectPrompt}
          shouldAutoLoadDefaultPrompt={props.shouldAutoLoadDefaultPrompt}
        />
      )}
      <CostIndicator
        variant="nub"
        agentDetail={agentDetail}
        pendingPriceLimitCents={props.pendingPriceLimitCents}
        priceLimit={props.priceLimit}
      />
      <ContextMeter
        variant="nub"
        contextPercentage={props.contextPercentage}
        contextSize={props.contextSize}
        restartThreshold={props.restartThreshold}
      />
      <AgentSettingsDialog
        variant="nub"
        agent={agentDetail ?? null}
        onUpdate={props.onAgentUpdate}
      />
      <ReportBugDialog variant="nub" agent={agentDetail ?? null} />
      <QueryInfoMenu />
    </>
  );
}
