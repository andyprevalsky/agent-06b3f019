/**
 * STATE MACHINE: CostIndicator
 *
 * [DISPLAY] <-- isEditing: false
 *     |
 *     | (click, only when editable — pending limit OR root agent)
 *     v
 * [EDITING] <-- isEditing: true, priceLimitInput: string
 *     |
 *     | (Enter / Escape / blur)
 *     v
 * [DISPLAY]
 *
 * Display rules:
 *   - No agent      : "0.00 / <pending>", editable
 *   - Root agent    : "cost / limit", editable + amber/red tint at 80%/100%
 *   - Child agent   : "cost" only, disabled
 */

import { DollarSign } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { COST_WARNING_RATIO, DEFAULT_AGENT_PRICE_LIMIT_CENTS } from '../../config';
import type { AgentDetail } from '../../hooks';
import { sanitizePriceInput, type UsePriceLimitResult } from './usePriceLimit';

interface CostIndicatorProps {
  agentDetail?: AgentDetail | null;
  pendingPriceLimitCents: number;
  priceLimit: UsePriceLimitResult;
}

export function CostIndicator({
  agentDetail,
  pendingPriceLimitCents,
  priceLimit,
}: CostIndicatorProps) {
  const treeCostCents = agentDetail?.tree_cost_cents || 0;
  const isChildAgent = !!agentDetail?.parent_agent_id;

  if (priceLimit.isEditing) {
    return <EditView treeCostCents={treeCostCents} priceLimit={priceLimit} />;
  }
  const warningClass = getWarningClass(agentDetail);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!isChildAgent) priceLimit.startEdit();
          }}
          disabled={isChildAgent}
          className={cn(
            'flex items-center gap-1 text-xs font-mono px-2 py-1 rounded-md border text-muted-foreground',
            warningClass,
            !isChildAgent && 'hover:bg-muted cursor-pointer',
            isChildAgent && 'cursor-default opacity-70',
          )}
        >
          <DollarSign className="h-3 w-3" />
          <span>{displayText(agentDetail, pendingPriceLimitCents)}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="z-[100]">
        <p className="text-xs">{tooltipText(agentDetail, pendingPriceLimitCents)}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function EditView({
  treeCostCents,
  priceLimit,
}: {
  treeCostCents: number;
  priceLimit: UsePriceLimitResult;
}) {
  return (
    <div className="flex items-center gap-1 text-muted-foreground text-xs font-mono px-2 py-1 border rounded-md">
      <DollarSign className="h-3 w-3" />
      <span>{(treeCostCents / 100).toFixed(2)} /</span>
      <Input
        value={priceLimit.input}
        onChange={(e) => priceLimit.setInput(sanitizePriceInput(e.target.value))}
        className="w-14 h-5 text-xs font-mono px-1 py-0 border border-foreground rounded"
        placeholder="1.00"
        disabled={priceLimit.isSaving}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Escape') void priceLimit.save();
        }}
        onBlur={() => void priceLimit.save()}
        autoFocus
      />
    </div>
  );
}

function getWarningClass(agentDetail?: AgentDetail | null): string {
  if (!agentDetail || agentDetail.parent_agent_id) return '';
  const cost = agentDetail.tree_cost_cents || 0;
  const limit = agentDetail.price_limit_cents || DEFAULT_AGENT_PRICE_LIMIT_CENTS;
  if (cost >= limit) return 'text-red-500 border-red-300 dark:border-red-700';
  if (cost >= limit * COST_WARNING_RATIO)
    return 'text-amber-500 border-amber-300 dark:border-amber-700';
  return '';
}

function displayText(agentDetail: AgentDetail | null | undefined, pendingCents: number): string {
  if (!agentDetail) return `0.00 / ${(pendingCents / 100).toFixed(2)}`;
  const cost = ((agentDetail.tree_cost_cents || 0) / 100).toFixed(2);
  if (agentDetail.parent_agent_id) return cost;
  const limit = ((agentDetail.price_limit_cents || DEFAULT_AGENT_PRICE_LIMIT_CENTS) / 100).toFixed(
    2,
  );
  return `${cost} / ${limit}`;
}

function tooltipText(agentDetail: AgentDetail | null | undefined, pendingCents: number): string {
  if (!agentDetail) {
    return `$${(pendingCents / 100).toFixed(2)} price limit set for this task. This limit is used to avoid runaway costs. (click to edit)`;
  }
  if (agentDetail.parent_agent_id) {
    return `Cost: $${((agentDetail.tree_cost_cents || 0) / 100).toFixed(2)}`;
  }
  const limit = (agentDetail.price_limit_cents || DEFAULT_AGENT_PRICE_LIMIT_CENTS) / 100;
  return `$${limit.toFixed(2)} price limit set for this task. This limit is used to avoid runaway costs. (click to edit)`;
}
