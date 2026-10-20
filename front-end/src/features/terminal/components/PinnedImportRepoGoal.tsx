/**
 * STATE MACHINE: PinnedImportRepoGoal
 * STATIC: one navi-black goal pill pinned at the LEFT of the Popular Goals row.
 *   [IDLE] --click--> onSelect(PINNED_IMPORT_REPO_GOAL) --> [IDLE]
 *
 * It never moves with the ticker (it is a sibling of the scrolling track, not
 * inside it). The pill is the spec'd goal-chip style; the import icon (tray +
 * down arrow) is bare — stroked with a white→rose gradient, no wrapper.
 */

import { useId } from 'react';

import { PINNED_IMPORT_REPO_GOAL, PINNED_IMPORT_REPO_LABEL } from '../config';

function ImportRepoIcon() {
  const gradientId = `import-repo-stroke-${useId().replace(/:/g, '')}`;
  return (
    <svg
      data-testid="pinned-import-repo-icon"
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-4 w-4 flex-none [filter:drop-shadow(0_0_4px_rgba(255,95,143,.55))]"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" />
          <stop offset=".55" stopColor="#ffc2d4" />
          <stop offset="1" stopColor="#ff5f8f" />
        </linearGradient>
      </defs>
      <path
        stroke={`url(#${gradientId})`}
        d="M12 3v11.5M7 10l5 5 5-5M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2"
      />
    </svg>
  );
}

export function PinnedImportRepoGoal({ onSelect }: { onSelect: (goal: string) => void }) {
  return (
    <button
      type="button"
      data-testid="pinned-import-repo-goal"
      onClick={() => onSelect(PINNED_IMPORT_REPO_GOAL)}
      className="relative z-[2] inline-flex h-[34px] flex-none cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-full bg-navi-black pl-[11px] pr-[13px] text-sm font-medium text-white shadow-[0_1px_2px_rgba(0,0,0,.12),0_4px_12px_rgba(39,39,37,.18)] md:h-[30px] md:text-[13px]"
    >
      <ImportRepoIcon />
      {PINNED_IMPORT_REPO_LABEL}
    </button>
  );
}
