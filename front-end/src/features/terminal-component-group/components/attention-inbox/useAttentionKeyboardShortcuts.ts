/**
 * Keyboard shortcuts for the open AttentionInbox modal:
 *  - Cmd/Ctrl + Enter: submit response for first unanswered request
 *  - Cmd/Ctrl + S:     skip first unanswered non-auth request
 */

import { useEffect } from 'react';
import { getAuthAssistanceMetadata, type AttentionRequest } from './types';

export interface UseAttentionKeyboardShortcutsArgs {
  isOpen: boolean;
  requests: AttentionRequest[];
  onRespond: (requestId: string) => void;
  onSkip: (requestId: string) => void;
}

export function useAttentionKeyboardShortcuts({
  isOpen,
  requests,
  onRespond,
  onSkip,
}: UseAttentionKeyboardShortcutsArgs): void {
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const firstUnanswered = requests.find((r) => !r.answered);
      if (!firstUnanswered) return;

      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (getAuthAssistanceMetadata(firstUnanswered)?.target) return;
        onRespond(firstUnanswered.id);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (getAuthAssistanceMetadata(firstUnanswered) !== null) return;
        onSkip(firstUnanswered.id);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, requests, onRespond, onSkip]);
}
