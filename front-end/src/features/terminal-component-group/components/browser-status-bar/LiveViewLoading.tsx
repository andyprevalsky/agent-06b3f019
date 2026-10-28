/**
 * LiveViewLoading — covers a provider live-view iframe until it has loaded.
 *
 * LOAD STATE (per URL):
 * [LOADING] --iframe load event--> [LOADED]
 *     ^                               |
 *     +-------- url changes ----------+
 *
 * A session swap remounts the iframe on the new session's URL; the user sees
 * this screen instead of a blank or half-connected provider page. It also
 * replaces the iframe entirely while the bound session is closed or ended.
 * Pair with useLiveViewLoaded for the per-URL load state.
 *
 * No z-index: render it right after the iframe and before overlay chips, so it
 * covers the stream while Take Control / Start Agent stay on top (tree order).
 */

import { Loader2, MonitorOff } from 'lucide-react';
import { cn } from '@/lib/utils';

export function LiveViewLoading({ compact = false }: { compact?: boolean }) {
  return (
    <div
      data-testid="live-view-loading"
      role="status"
      aria-label="Connecting to browser"
      className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black text-white/80"
    >
      <Loader2 className={cn('animate-spin', compact ? 'h-4 w-4' : 'h-6 w-6')} />
      {!compact && <span className="text-sm">Connecting to browser…</span>}
    </div>
  );
}

/**
 * LiveViewEnded — terminal state for a finished agent's browser. Replaces the
 * iframe and LiveViewLoading so a task that never recorded its own end does not
 * read "Connecting…" forever.
 */
export function LiveViewEnded({ compact = false }: { compact?: boolean }) {
  return (
    <div
      data-testid="live-view-ended"
      role="status"
      aria-label="Browser session ended"
      className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black text-white/70"
    >
      <MonitorOff className={compact ? 'h-4 w-4' : 'h-6 w-6'} />
      {!compact && <span className="text-sm">Browser session ended</span>}
    </div>
  );
}
