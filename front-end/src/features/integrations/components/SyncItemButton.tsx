/**
 * STATE MACHINE: SyncItemButton
 *
 * [IDLE] --click--> [LOADING] --done--> [SYNCED] or [IDLE]
 *
 * Pure presentation: loading/synced state is passed in from hooks.
 */

import { Loader2, Check, RefreshCw } from 'lucide-react';

interface SyncItemButtonProps {
  isLoading: boolean;
  isSynced: boolean;
  onClick: () => void;
  disabled?: boolean;
}

export default function SyncItemButton({
  isLoading,
  isSynced,
  onClick,
  disabled,
}: SyncItemButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={isLoading || disabled}
      className={`h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 ${
        isSynced
          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
          : 'bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground'
      }`}
    >
      {isLoading ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : isSynced ? (
        <Check className="w-3.5 h-3.5" />
      ) : (
        <RefreshCw className="w-3.5 h-3.5" />
      )}
    </button>
  );
}
