/**
 * NubTip + nub item styles for the Rose Desktop query-box tab (NubTab).
 *
 * Every nub item has an instant hover tooltip (navi black #272725, 11.5px,
 * above the item). Items are bare: white 12px icons / 10px mono text on the
 * tab's Rose gradient, no wrapper; hover/focus changes opacity only.
 *
 * Stateless: the tooltip open state is owned by Radix Tooltip.
 */

import type { ReactElement } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** Bare white item on the nub strip (icon 12px). */
export const NUB_ITEM_CLASS =
  'inline-flex h-[18px] cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-white transition-opacity hover:opacity-80 focus-visible:opacity-80 focus-visible:outline-none disabled:cursor-default [&_svg]:h-3 [&_svg]:w-3 [&_svg]:shrink-0 [&_svg]:drop-shadow-[0_1px_1px_rgba(80,0,60,.25)]';

/** 10px mono numbers (budget, context %). */
export const NUB_TEXT_CLASS =
  'font-mono text-[10px] font-semibold tracking-[-0.01em] [text-shadow:0_1px_1px_rgba(80,0,60,.25)]';

export function NubTip({ label, children }: { label: string; children: ReactElement }) {
  return (
    // Plain labels: no hoverable content, so moving to the next item is instant.
    <Tooltip delayDuration={0} disableHoverableContent>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={8}
        data-testid="nub-tip"
        className="z-[300] whitespace-nowrap rounded-md border-0 bg-[#272725] px-2 py-[5px] text-[11.5px] font-medium text-[#f5f5f5] shadow-[0_4px_14px_rgba(0,0,0,.18)] dark:bg-[#272725]"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
