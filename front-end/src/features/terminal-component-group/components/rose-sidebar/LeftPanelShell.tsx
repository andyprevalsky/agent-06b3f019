/**
 * STATE MACHINE: LeftPanelShell (panels that open beside the Rose left bar)
 *
 *   [CLOSED] not rendered
 *   [OPEN]   flush against the bar: full height, no gap, margin or floating card;
 *            left = 64px (collapsed bar) or the bar's expanded width (236px
 *            default, wider once dragged) while it is expanded,
 *            so the bar never covers it (left transitions with the bar width);
 *            width = min(640px, room left of the top-right app icons), so on
 *            narrow windows it never slides under the icon row
 *   [OPEN] --Escape | close button--> onClose
 *
 * LAYER: portaled to document.body at ROSE_LAYER.leftPanel: over the floating
 * query box (ROSE_LAYER.composer), under app panels opened after it
 * (ROSE_LAYER.coverPanel). Rendered in place it sat inside the main row's
 * z-[4] stacking context, under the query box.
 *
 * Used by project settings (UI ledger rows 18/19/59).
 */

import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { ROSE_LAYER } from '@/lib/roseLayers';
import { cn } from '@/lib/utils';

import { ROSE_BAR_EASE, ROSE_BAR_EXPANDED_WIDTH, ROSE_BAR_WIDTH } from './roseSidebarLayout';

/** Gap kept between the panel's right edge and the top-right app icons. */
const ICON_ROW_GAP = 16;

/** At most 640px, ending left of the app icon row (--rose-app-icons-inset, published by RoseAppsProvider). */
function leftPanelWidth(left: number): string {
  return `min(640px, calc(100vw - ${left}px - var(--rose-app-icons-inset, ${ROSE_BAR_WIDTH}px) - ${ICON_ROW_GAP}px))`;
}

export default function LeftPanelShell({
  label,
  testId,
  barExpanded,
  barExpandedWidth = ROSE_BAR_EXPANDED_WIDTH,
  onClose,
  children,
}: {
  label: string;
  testId: string;
  barExpanded: boolean;
  /** The bar's current expanded width (useSidebarExpansion); defaults to 236px. */
  barExpandedWidth?: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const left = barExpanded ? barExpandedWidth : ROSE_BAR_WIDTH;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <section
      aria-label={label}
      data-testid={testId}
      className={cn(
        'fixed bottom-0 top-0 hidden overflow-y-auto border-r border-gray-200/95 dark:border-white/[0.09] bg-white dark:bg-[#262624] px-[26px] py-[22px] text-[13px] text-[hsl(240_15%_8%)] dark:text-[#ecece8] shadow-[12px_0_40px_rgba(20,20,40,0.08)] md:block',
        ROSE_LAYER.leftPanel,
      )}
      style={{
        left,
        width: leftPanelWidth(left),
        transition: `left 280ms ${ROSE_BAR_EASE}, width 280ms ${ROSE_BAR_EASE}`,
      }}
    >
      <button
        type="button"
        aria-label={`Close ${label.toLowerCase()}`}
        onClick={onClose}
        className="absolute right-4 top-4 text-[hsl(240_8%_45%)] dark:text-[#a3a39d] hover:text-[hsl(240_15%_8%)] dark:hover:text-[#ecece8]"
      >
        <X className="h-4 w-4" />
      </button>
      {children}
    </section>,
    document.body,
  );
}
