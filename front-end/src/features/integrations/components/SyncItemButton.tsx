/**
 * STATE MACHINE: SyncItemButton
 *
 * [IDLE|SYNCED] --plus click--> [LOADING] --done--> [SYNCED] or [IDLE]
 *
 * Pure presentation: loading state is passed in from hooks. Synced state shows the
 * shared rose "Connected" label next to the action, mirroring the section header
 * (SectionToggleButton) so a connected row reads the same as a connected section.
 * The action icon stays a plus in every state -- rows remain re-syncable.
 */

import { Loader2, Plus } from 'lucide-react';

import ConnectedLabel from './ConnectedLabel';

interface SyncItemButtonProps {
  isLoading: boolean;
  isSynced: boolean;
  onClick: () => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export default function SyncItemButton({
  isLoading,
  isSynced,
  onClick,
  disabled,
  ariaLabel,
}: SyncItemButtonProps) {
  return (
    <div className="flex items-center gap-2">
      {isSynced && <ConnectedLabel size="row" />}
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
    </div>
  );
}
