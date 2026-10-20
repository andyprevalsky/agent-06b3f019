/**
 * STATE MACHINE: NubToolbar (items on the Rose Desktop query-box tab)
 *
 * Stateless layout; each item owns its own state (lock toggle, popovers,
 * price-limit edit, settings dialog, info menu). Order, left → right:
 *
 *   lock · context files* · tools · simulator* · budget · context % · settings · info
 *   (* account-gated: context files = dev/admin desktop, simulator = allow-listed)
 *
 * Every item is a bare white 12px icon or 10px mono text with an instant
 * tooltip (NubTip). Speed is not here: it sits next to the model selector.
 * Replaces the stock in-box TopBar row for Rose Desktop accounts only.
 */

import WriteLockToggle from '../WriteLockToggle';
import SimulatorToggle from '../SimulatorToggle';
import RoseToolSetChip from '../RoseToolSetChip';
import TestPromptsSelector from '../TestPromptsSelector';
import AgentSettingsDialog from '../AgentSettingsDialog';
import { CostIndicator } from './CostIndicator';
import { ContextMeter } from './ContextMeter';
import { QueryInfoMenu } from './QueryInfoMenu';
import type { TopBarProps } from './TopBar';

export function NubToolbar(props: TopBarProps) {
  const { agentDetail, showSimulator = false } = props;
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
      <RoseToolSetChip variant="nub" />
      {showSimulator && (
        <SimulatorToggle
          variant="nub"
          enabled={props.simulatorMode ?? false}
          onChange={props.onSimulatorModeChange ?? (() => {})}
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
        onDelete={props.onAgentDelete}
      />
      <QueryInfoMenu />
    </>
  );
}
