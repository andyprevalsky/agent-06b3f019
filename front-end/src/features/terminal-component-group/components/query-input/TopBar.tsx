/**
 * TopBar — row above the textarea: write-lock toggle, tool-set chip,
 * test-prompt selector (dev/admin only), cost indicator, context meter,
 * and the settings dialog.
 */

import WriteLockToggle from '../WriteLockToggle';
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
