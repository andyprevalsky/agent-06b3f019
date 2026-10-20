/**
 * STATE MACHINE: LeftPanelShell (panels that open beside the Rose left bar)
 *
 *   [CLOSED] not rendered
 *   [OPEN]   flush against the bar: full height, no gap, margin or floating card;
 *            left = 64px (collapsed bar) or 236px while the bar hover-expands,
 *            so the bar never covers it (left transitions with the bar width)
 *   [OPEN] --Escape | close button--> onClose
 *
 * Used by project settings and account settings (UI ledger rows 18/19/59).
 */

import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

import { ROSE_BAR_EASE, ROSE_BAR_EXPANDED_WIDTH, ROSE_BAR_WIDTH } from './roseSidebarLayout';

export default function LeftPanelShell({
  label,
  testId,
  barExpanded,
  onClose,
  children,
}: {
  label: string;
  testId: string;
  barExpanded: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <section
      aria-label={label}
      data-testid={testId}
      className="fixed bottom-0 top-0 z-[65] hidden overflow-y-auto border-r border-gray-200/95 dark:border-white/[0.09] bg-white dark:bg-[#262624] px-[26px] py-[22px] text-[13px] text-[hsl(240_15%_8%)] dark:text-[#ecece8] shadow-[12px_0_40px_rgba(20,20,40,0.08)] md:block"
      style={{
        left: barExpanded ? ROSE_BAR_EXPANDED_WIDTH : ROSE_BAR_WIDTH,
        width: `min(640px, calc(100vw - ${ROSE_BAR_WIDTH * 2}px))`,
        transition: `left 280ms ${ROSE_BAR_EASE}`,
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
    </section>
  );
}
