/**
 * STATE MACHINE: TopBar
 *
 * VISIBILITY STATE:
 * [BASE_CONTROLS] --> always renders write-lock (far left), toolset (wrench, left of fast mode), cost, context,
 *                     report bug (admin only, its own icon left of the gear), settings
 *     |
 *     +--> [TEST_PROMPTS_VISIBLE] when parent says viewport is desktop and account is dev/admin
 *     |      (doc icon, right after write-lock)
 *     |
 *     +--> [FAST_MODE_VISIBLE] when parent says the operator can use Fast Mode
 *            (admin id, verified admin phone, or live impersonation)
 *     |
 *     +--> [SIMULATOR_VISIBLE] when parent says the account is simulator-allow-listed
 *
 * Stock UI only: Rose Desktop accounts get NubToolbar on the tab behind the
 * query box instead (see QueryInput / ToolbarNub.tsx).
 *
 * TopBar owns layout only; account and viewport gating stay in QueryInputBody.
 */

import WriteLockToggle from '../WriteLockToggle';
import FastModeToggle from '../FastModeToggle';
import SimulatorToggle from '../SimulatorToggle';
import RoseToolSetChip from '../RoseToolSetChip';
import TestPromptsSelector from '../TestPromptsSelector';
import AgentSettingsDialog from '../AgentSettingsDialog';
import ReportBugDialog from '../ReportBugDialog';
import { CostIndicator } from './CostIndicator';
import { ContextMeter } from './ContextMeter';
import type { AgentDetail } from '../../hooks';
import type { UsePriceLimitResult } from './usePriceLimit';

export interface TopBarProps {
  agentDetail?: AgentDetail | null;
  onAgentUpdate?: () => void;
  onAgentDelete?: () => void;
  showTestPrompts: boolean;
  showFastMode?: boolean;
  fastMode?: boolean;
  onFastModeChange?: (enabled: boolean) => void;
  showSimulator?: boolean;
  simulatorMode?: boolean;
  onSimulatorModeChange?: (enabled: boolean) => void;
  onSelectPrompt: (prompt: string, files?: File[]) => void;
  shouldAutoLoadDefaultPrompt: () => boolean;
  pendingPriceLimitCents: number;
  priceLimit: UsePriceLimitResult;
  contextPercentage: number;
  contextSize: number;
  restartThreshold: number;
}

export function TopBar({
  agentDetail,
  onAgentUpdate,
  onAgentDelete,
  showTestPrompts,
  showFastMode = false,
  fastMode = false,
  onFastModeChange,
  showSimulator = false,
  simulatorMode = false,
  onSimulatorModeChange,
  onSelectPrompt,
  shouldAutoLoadDefaultPrompt,
  pendingPriceLimitCents,
  priceLimit,
  contextPercentage,
  contextSize,
  restartThreshold,
}: TopBarProps) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 pb-2">
      <div className="flex items-center gap-2">
        <div className="hidden md:block">
          <WriteLockToggle
            agentId={agentDetail?.agent_id}
            writeLockEnabled={agentDetail?.write_lock_enabled ?? true}
            onUpdate={onAgentUpdate}
          />
        </div>
        {showTestPrompts && (
          <TestPromptsSelector
            onSelectPrompt={onSelectPrompt}
            shouldAutoLoadDefaultPrompt={shouldAutoLoadDefaultPrompt}
          />
        )}
        <RoseToolSetChip />
        {showFastMode && (
          <FastModeToggle enabled={fastMode} onChange={onFastModeChange ?? (() => {})} />
        )}
        {showSimulator && (
          <SimulatorToggle enabled={simulatorMode} onChange={onSimulatorModeChange ?? (() => {})} />
        )}
      </div>
      <div className="flex items-center gap-2">
        <CostIndicator
          agentDetail={agentDetail}
          pendingPriceLimitCents={pendingPriceLimitCents}
          priceLimit={priceLimit}
        />
        <ContextMeter
          contextPercentage={contextPercentage}
          contextSize={contextSize}
          restartThreshold={restartThreshold}
        />
        <ReportBugDialog agent={agentDetail ?? null} />
        <AgentSettingsDialog
          agent={agentDetail}
          onUpdate={onAgentUpdate}
          onDelete={onAgentDelete}
        />
      </div>
    </div>
  );
}
