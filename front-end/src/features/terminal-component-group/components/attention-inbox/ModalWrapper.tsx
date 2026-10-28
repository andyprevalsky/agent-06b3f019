/**
 * Lightweight popover wrapper for the AttentionInbox: fixed backdrop that
 * closes on click + anchored positioned card shell. Rendering is skipped when
 * `isOpen` is false, so callers can mount/unmount unconditionally.
 *
 * Desktop (md+): anchored under the bell, right-aligned to it.
 * Phones (< md): the bell sits mid-header, so a right-aligned card would hang
 * off the left edge; the card instead spans the screen just below the
 * safe-area-aware mobile header and scrolls inside the remaining height.
 */

import type { ReactNode } from 'react';

interface ModalWrapperProps {
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function ModalWrapper({ isOpen, onClose, children }: ModalWrapperProps) {
  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute top-12 right-0 z-50 w-[min(500px,calc(100vw-32px))] bg-card dark:bg-navi-black border border-border dark:border-navi-light-black rounded-lg shadow-lg max-md:fixed max-md:inset-x-2 max-md:top-[calc(var(--mobile-terminal-header-height)+0.5rem)] max-md:w-auto max-md:max-h-[calc(100dvh-var(--mobile-terminal-header-height)-1rem-var(--safe-area-inset-bottom))] max-md:overflow-y-auto">
        <div className="p-4 space-y-4">{children}</div>
      </div>
    </>
  );
}

export function EmptyInboxState() {
  return (
    <div className="text-center py-8 space-y-2">
      <p className="text-sm font-medium text-foreground">🎉 Congrats!</p>
      <p className="text-sm text-muted-foreground">
        All your agents are unblocked and busy working on your goals.
      </p>
    </div>
  );
}
