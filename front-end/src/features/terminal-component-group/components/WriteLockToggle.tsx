/**
 * STATE MACHINE: WriteLockToggle
 *
 * [LOCKED] <-- writeLockEnabled: true (default, safe)
 *     |
 *     | (click)
 *     v
 * [UNLOCKED] <-- writeLockEnabled: false (dangerous, autonomous writes)
 *     |
 *     | (click)
 *     v
 * [LOCKED]
 *
 * State:
 * - writeLockEnabled: boolean (from agent or local state)
 * - localLocked: boolean (used when no agent selected)
 * - isUpdating: boolean (API call in progress)
 *
 * variant 'pill' (stock): "Safe Writes" pill with the detailed tooltip.
 * variant 'nub' (Rose Desktop tab): one small bare lock icon, white when
 * locked, rose (open lock) when unlocked; instant tooltip
 * "Safe writes on · click to unlock" / "Writes unlocked · click to lock".
 */

import { Lock, Unlock } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { updateAgent } from '../hooks';
import { NUB_ITEM_CLASS, NubTip } from './query-input/NubTip';

interface WriteLockToggleProps {
  agentId: string | undefined;
  writeLockEnabled: boolean;
  onUpdate?: () => void;
  onLocalChange?: (locked: boolean) => void;
  variant?: 'pill' | 'nub';
}

/** Deep rose: reads on the tab's light orange/pink end, where white is faint. */
const UNLOCKED_ROSE = '#c8104f';

function NubWriteLock({
  isLocked,
  disabled,
  onToggle,
}: {
  isLocked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <NubTip
      label={isLocked ? 'Safe writes on · click to unlock' : 'Writes unlocked · click to lock'}
    >
      <button
        type="button"
        data-nub-item
        data-testid="nub-write-lock"
        data-state={isLocked ? 'locked' : 'unlocked'}
        aria-label={isLocked ? 'Safe writes on' : 'Writes unlocked'}
        aria-pressed={isLocked}
        onClick={onToggle}
        disabled={disabled}
        className={NUB_ITEM_CLASS}
        style={isLocked ? undefined : { color: UNLOCKED_ROSE }}
      >
        {isLocked ? <Lock strokeWidth={2.4} /> : <Unlock strokeWidth={2.6} />}
      </button>
    </NubTip>
  );
}

function LockedTooltip() {
  return (
    <div className="text-xs space-y-1">
      <p>
        <span className="font-semibold">Write lock enabled.</span> Rose will ask permission before
        committing writes to the internet:
      </p>
      <ul className="list-disc list-inside text-muted-foreground">
        <li>Sending emails or texts</li>
        <li>Submitting payment details</li>
        <li>Posting on social media</li>
      </ul>
    </div>
  );
}

function UnlockedTooltip() {
  return (
    <div className="text-xs space-y-1">
      <p>
        <span className="font-semibold text-red-500">Write lock disabled.</span> Rose can act
        autonomously without asking:
      </p>
      <ul className="list-disc list-inside text-muted-foreground">
        <li>Send emails or texts</li>
        <li>Submit payment details</li>
        <li>Post on social media</li>
      </ul>
      <p className="text-red-500">Click to enable protection.</p>
    </div>
  );
}

export default function WriteLockToggle({
  agentId,
  writeLockEnabled,
  onUpdate,
  onLocalChange,
  variant = 'pill',
}: WriteLockToggleProps) {
  const [isUpdating, setIsUpdating] = useState(false);
  const [localLocked, setLocalLocked] = useState(true);

  useEffect(() => {
    if (agentId) {
      setLocalLocked(writeLockEnabled);
    }
  }, [agentId, writeLockEnabled]);

  const isLocked = agentId ? writeLockEnabled : localLocked;

  const handleToggle = useCallback(() => {
    if (isUpdating) return;
    const newValue = !isLocked;

    if (agentId) {
      setIsUpdating(true);
      updateAgent(agentId, { write_lock_enabled: newValue })
        .then(() => {
          onUpdate?.();
        })
        .catch((error: unknown) => {
          console.error('Failed to update write lock:', error);
        })
        .finally(() => {
          setIsUpdating(false);
        });
    } else {
      setLocalLocked(newValue);
      onLocalChange?.(newValue);
    }
  }, [agentId, isLocked, isUpdating, onLocalChange, onUpdate]);

  if (variant === 'nub') {
    return <NubWriteLock isLocked={isLocked} disabled={isUpdating} onToggle={handleToggle} />;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={handleToggle}
          disabled={isUpdating}
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs transition-all',
            isLocked
              ? 'border-border bg-muted/50 text-muted-foreground hover:bg-muted'
              : 'border-red-500/50 bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 animate-pulse',
            isUpdating && 'opacity-50 cursor-not-allowed',
          )}
        >
          {isLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
          <span className="font-medium">{isLocked ? 'Safe Writes' : 'Skip Write Permissions'}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[300px] z-[100]">
        {isLocked ? <LockedTooltip /> : <UnlockedTooltip />}
      </TooltipContent>
    </Tooltip>
  );
}
