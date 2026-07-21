/**
 * STATE MACHINE: AttentionInbox
 *
 * DATA LOADING:
 * [LOADING] <-- initial render
 *     |
 *     v (fetch complete)
 * [READY] <-- requests: AttentionRequest[]
 *     |
 *     +--> [RECONNECTING] <-- realtime disconnect (exponential backoff in hook)
 *
 * RESPONDING TO REQUEST:
 * [IDLE] <-- actionRequestId: null
 *     |
 *     | (click Accept/Skip/Reject/Authentication Complete)
 *     v
 * [PENDING_ACTION] <-- loading: true
 *     |
 *     | (mutation resolves)
 *     v
 * [IDLE]
 *
 * This file is the composition root. Details live in `attention-inbox/`:
 *   - useAttentionRequests: fetch + polling + realtime subscription
 *   - useAttentionActions:  accept / skip / reject / iMessage send
 *   - useAttentionKeyboardShortcuts: Cmd+Enter / Cmd+S
 *   - RequestListItem / RequestActionButtons / ModalWrapper: UI shells
 */

import { useState } from 'react';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ModalWrapper } from './attention-inbox/ModalWrapper';
import { AttentionInboxContent } from './attention-inbox/AttentionInboxContent';
import { unansweredCount, useAttentionRequests } from './attention-inbox/useAttentionRequests';
import type { AttentionInboxProps } from './attention-inbox/types';

export default function AttentionInbox({
  onSelectAgent,
  realtimeReady = false,
}: AttentionInboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { requests, refetch } = useAttentionRequests(realtimeReady);
  const badgeCount = unansweredCount(requests);

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setIsOpen((prev) => !prev)}
        className="relative"
        aria-label="Attention requests"
      >
        <Bell className="h-5 w-5" />
        {badgeCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold flex items-center justify-center">
            {badgeCount > 99 ? '99+' : badgeCount}
          </span>
        )}
      </Button>

      <ModalWrapper isOpen={isOpen} onClose={() => setIsOpen(false)}>
        <AttentionInboxContent
          requests={requests}
          refetch={refetch}
          isActive={isOpen}
          onSelectAgent={onSelectAgent}
          onClose={() => setIsOpen(false)}
        />
      </ModalWrapper>
    </div>
  );
}
