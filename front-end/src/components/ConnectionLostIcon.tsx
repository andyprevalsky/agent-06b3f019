/**
 * STATE MACHINE: ConnectionLostIcon
 *
 * [ONLINE]  --> renders nothing
 * [OFFLINE] --> bare red wifi-off icon, announced as "No connection"
 *
 * Transitions follow useOnlineStatus (online/offline events, re-read on
 * mobile resume). Rendered by TerminalHeader just left of the notifications
 * bell (left of the menu on the stock mobile bar), so the site, phones and
 * the Mac app show it in the same place.
 */

import { WifiOff } from 'lucide-react';

import { useOnlineStatus } from '@/hooks/use-online-status';
import { cn } from '@/lib/utils';

export function ConnectionLostIcon({ className }: { className?: string }) {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <span
      role="status"
      title="No connection"
      data-testid="connection-lost-icon"
      className={cn('grid flex-none place-items-center text-red-600 dark:text-red-400', className)}
    >
      <WifiOff aria-hidden="true" className="h-4 w-4" />
      <span className="sr-only">No connection</span>
    </span>
  );
}
