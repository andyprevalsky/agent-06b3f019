/**
 * STATE MACHINE: SyncItemButton
 *
 * [IDLE|SYNCED] --plus click--> [LOADING] --done--> [SYNCED] or [IDLE]
 *
 * Pure presentation: loading state is passed in from hooks. Synced state is
 * represented by the row icon glow, so the action icon remains stable.
 */

import { Loader2, Plus } from 'lucide-react';

interface SyncItemButtonProps {
  isLoading: boolean;
  isSynced: boolean;
  onClick: () => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export default function SyncItemButton({
  isLoading,
  onClick,
  disabled,
  ariaLabel,
}: SyncItemButtonProps) {
  return (
    <button
      onClick={onClick}
      aria-label={ariaLabel}
      disabled={isLoading || disabled}
      className="h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground disabled:opacity-60"
    >
      {isLoading ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <Plus className="w-3.5 h-3.5" />
      )}
    </button>
  );
}
