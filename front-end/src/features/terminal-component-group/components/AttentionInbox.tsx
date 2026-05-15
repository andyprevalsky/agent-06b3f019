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
 *     | (click Accept/Skip/Reject)
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

import { useCallback, useState } from 'react';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyInboxState, ModalWrapper } from './attention-inbox/ModalWrapper';
import { RequestListItem } from './attention-inbox/RequestListItem';
import { useAttentionActions } from './attention-inbox/useAttentionActions';
import { useAttentionKeyboardShortcuts } from './attention-inbox/useAttentionKeyboardShortcuts';
import { useAttentionRequests } from './attention-inbox/useAttentionRequests';
import type { AttentionInboxProps } from './attention-inbox/types';

export default function AttentionInbox({
  onSelectAgent,
  realtimeReady = false,
}: AttentionInboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [responses, setResponses] = useState<Record<string, string>>({});

  const { requests, refetch } = useAttentionRequests(realtimeReady);

  const clearResponse = useCallback((requestId: string) => {
    setResponses((prev) => {
      const next = { ...prev };
      delete next[requestId];
      return next;
    });
  }, []);

  const {
    loading,
    actionRequestId,
    handleRespond,
    handleSkip,
    handleReject,
    handleSendViaIMessage,
  } = useAttentionActions({ requests, responses, clearResponse, refetch, setIsOpen });

  useAttentionKeyboardShortcuts({
    isOpen,
    requests,
    onRespond: handleRespond,
    onSkip: handleSkip,
  });

  const handleChangeResponse = useCallback((requestId: string, text: string) => {
    setResponses((prev) => ({ ...prev, [requestId]: text }));
  }, []);

  const unansweredRequests = requests.filter((r) => !r.answered);
  const badgeCount = unansweredRequests.length;
  const firstUnanswered = unansweredRequests[0];
  const remainingCount = unansweredRequests.length - 1;

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
        {firstUnanswered ? (
          <RequestListItem
            request={firstUnanswered}
            remainingCount={remainingCount}
            responseText={responses[firstUnanswered.id] ?? ''}
            loading={loading}
            actionRequestId={actionRequestId}
            onSelectAgent={onSelectAgent}
            onClose={() => setIsOpen(false)}
            onChangeResponse={handleChangeResponse}
            onAccept={handleRespond}
            onSkip={handleSkip}
            onReject={handleReject}
            onSendViaIMessage={handleSendViaIMessage}
          />
        ) : (
          <EmptyInboxState />
        )}
      </ModalWrapper>
    </div>
  );
}
