/**
 * STATE MACHINE: BrowserControls
 *
 * [ACTIVE] -> green pulsing dot + "Browser Session Active"
 * [WAITING_FOR_AUTH_ASSISTANCE] -> yellow steady dot + "Agent waiting for assistance"
 * [DISCONNECTED] -> yellow steady dot + "Browser Session Disconnected"
 */

import { Maximize2, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BrowserControlsProps {
  isFullscreen: boolean;
  isDisconnected: boolean;
  isWaitingForAuthAssistance: boolean;
  onToggleFullscreen: () => void;
}

export function BrowserControls({
  isFullscreen,
  isDisconnected,
  isWaitingForAuthAssistance,
  onToggleFullscreen,
}: BrowserControlsProps) {
  const label = isDisconnected
    ? 'Browser Session Disconnected'
    : isWaitingForAuthAssistance
      ? 'Agent waiting for assistance'
      : 'Browser Session Active';

  return (
    <div
      className={cn(
        'flex items-center justify-between p-3 border-b border-border bg-muted/30 border-t border-r border-border',
        !isFullscreen && 'rounded-tr-lg',
      )}
    >
      <div className="flex items-center gap-2">
        <div
          className={cn(
            'h-2 w-2 rounded-full',
            isDisconnected || isWaitingForAuthAssistance
              ? 'bg-yellow-500'
              : 'bg-green-500 animate-pulse',
          )}
        />
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onToggleFullscreen}
          className="p-1.5 rounded hover:bg-muted transition-colors"
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {isFullscreen ? (
            <X className="h-4 w-4 text-muted-foreground" />
          ) : (
            <Maximize2 className="h-4 w-4 text-muted-foreground" />
          )}
        </button>
      </div>
    </div>
  );
}
