/**
 * STATE MACHINE: TopBar
 *
 * VISIBILITY STATE:
 * [BASE_CONTROLS] --> always renders write-lock, toolset, cost, context, settings
 *     |
 *     +--> [FAST_MODE_VISIBLE] when parent says the account is allow-listed
 *     |
 *     +--> [TEST_PROMPTS_VISIBLE] when parent says viewport is desktop and account is dev/admin
 *
 * TopBar owns layout only; account and viewport gating stay in QueryInputBody.
 */

import WriteLockToggle from '../WriteLockToggle';
import FastModeToggle from '../FastModeToggle';
import RoseToolSetChip from '../RoseToolSetChip';
import TestPromptsSelector from '../TestPromptsSelector';
import AgentSettingsDialog from '../AgentSettingsDialog';
import { CostIndicator } from './CostIndicator';
import { ContextMeter } from './ContextMeter';
import type { AgentDetail } from '../../hooks';
import type { UsePriceLimitResult } from './usePriceLimit';

interface TopBarProps {
  agentDetail?: AgentDetail | null;
  onAgentUpdate?: () => void;
  onAgentDelete?: () => void;
  showTestPrompts: boolean;
  showFastMode?: boolean;
  fastMode?: boolean;
  onFastModeChange?: (enabled: boolean) => void;
  onSelectPrompt: (prompt: string, files?: File[]) => void;
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
  onSelectPrompt,
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
        {showFastMode && (
          <FastModeToggle enabled={fastMode} onChange={onFastModeChange ?? (() => {})} />
        )}
        <RoseToolSetChip />
        {showTestPrompts && <TestPromptsSelector onSelectPrompt={onSelectPrompt} />}
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
        <AgentSettingsDialog
          agent={agentDetail}
          onUpdate={onAgentUpdate}
          onDelete={onAgentDelete}
        />
      </div>
    </div>
  );
}
