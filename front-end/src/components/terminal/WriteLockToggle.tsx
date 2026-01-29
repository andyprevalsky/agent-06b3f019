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
 */

import { Lock, LockOpen } from 'lucide-react';
import { useState, useEffect } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { updateAgent } from '@/lib/api';

interface WriteLockToggleProps {
  agentId: string | undefined;
  writeLockEnabled: boolean;
  onUpdate?: () => void;
  onLocalChange?: (locked: boolean) => void;
}

export default function WriteLockToggle({
  agentId,
  writeLockEnabled,
  onUpdate,
  onLocalChange,
}: WriteLockToggleProps) {
  const [isUpdating, setIsUpdating] = useState(false);
  const [localLocked, setLocalLocked] = useState(true);

  // Sync local state with agent state when agent changes
  useEffect(() => {
    if (agentId) {
      setLocalLocked(writeLockEnabled);
    }
  }, [agentId, writeLockEnabled]);

  const handleToggle = async () => {
    if (isUpdating) return;

    const newValue = !isLocked;

    if (agentId) {
      // Update agent via API
      setIsUpdating(true);
      try {
        await updateAgent(agentId, {
          write_lock_enabled: newValue,
        });
        onUpdate?.();
      } catch (error) {
        console.error('Failed to update write lock:', error);
      } finally {
        setIsUpdating(false);
      }
    } else {
      // Update local state (no agent yet)
      setLocalLocked(newValue);
      onLocalChange?.(newValue);
    }
  };

  // Use agent state if available, otherwise use local state
  const isLocked = agentId ? writeLockEnabled : localLocked;

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
            isUpdating && 'opacity-50 cursor-not-allowed'
          )}
        >
          {isLocked ? (
            <Lock className="h-3.5 w-3.5" />
          ) : (
            <LockOpen className="h-3.5 w-3.5" />
          )}
          <span className="font-medium">
            {isLocked ? 'Safe Writes' : 'Skip Write Permissions'}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[300px] z-[100]">
        {isLocked ? (
          <div className="text-xs space-y-1">
            <p><span className="font-semibold">Write lock enabled.</span> Rose will ask permission before committing writes to the internet:</p>
            <ul className="list-disc list-inside text-muted-foreground">
              <li>Sending emails or texts</li>
              <li>Submitting payment details</li>
              <li>Posting on social media</li>
            </ul>
          </div>
        ) : (
          <div className="text-xs space-y-1">
            <p><span className="font-semibold text-red-500">Write lock disabled.</span> Rose can act autonomously without asking:</p>
            <ul className="list-disc list-inside text-muted-foreground">
              <li>Send emails or texts</li>
              <li>Submit payment details</li>
              <li>Post on social media</li>
            </ul>
            <p className="text-red-500">Click to enable protection.</p>
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
