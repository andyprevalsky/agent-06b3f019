/**
 * STATE MACHINE: AttentionInboxContent
 *
 * RESPONDING TO REQUEST:
 * [IDLE] --click Accept/Skip/Reject/Auth-Complete--> [PENDING_ACTION] --resolves--> [IDLE]
 *
 * Presentational body of the attention inbox: the responses draft state, the
 * accept/skip/reject/iMessage actions, keyboard shortcuts, and the
 * RequestListItem / EmptyInboxState render. The `requests` list + `refetch` are
 * OWNED BY THE PARENT (via useAttentionRequests) so the same subscription drives
 * BOTH the badge count and this content — no double subscription. Reused by the
 * desktop AttentionInbox (bell modal) and the mobile menu drawer (Notifications
 * tab).
 */

import { useCallback, useState } from 'react';

import { EmptyInboxState } from './ModalWrapper';
import { RequestListItem } from './RequestListItem';
import { useAttentionActions } from './useAttentionActions';
import { useAttentionKeyboardShortcuts } from './useAttentionKeyboardShortcuts';
import type { AttentionRequest } from './types';

interface AttentionInboxContentProps {
  requests: AttentionRequest[];
  refetch: () => Promise<void>;
  /** Whether this content is currently visible (gates keyboard shortcuts). */
  isActive: boolean;
  onSelectAgent: (agentId: string | null) => void;
  onClose: () => void;
}

export function AttentionInboxContent({
  requests,
  refetch,
  isActive,
  onSelectAgent,
  onClose,
}: AttentionInboxContentProps) {
  const [responses, setResponses] = useState<Record<string, string>>({});

  const clearResponse = useCallback((requestId: string) => {
    setResponses((prev) => {
      const next = { ...prev };
      delete next[requestId];
      return next;
    });
  }, []);

  const { loading, actionRequestId, handleRespond, handleSkip, handleReject, handleSendViaIMessage } =
    useAttentionActions({
      requests,
      responses,
      clearResponse,
      refetch,
      setIsOpen: (open: boolean) => {
        if (!open) onClose();
      },
    });

  useAttentionKeyboardShortcuts({
    isOpen: isActive,
    requests,
    onRespond: handleRespond,
    onSkip: handleSkip,
  });

  const handleChangeResponse = useCallback((requestId: string, text: string) => {
    setResponses((prev) => ({ ...prev, [requestId]: text }));
  }, []);

  const unansweredRequests = requests.filter((r) => !r.answered);
  const firstUnanswered = unansweredRequests[0];
  const remainingCount = unansweredRequests.length - 1;

  if (!firstUnanswered) {
    return <EmptyInboxState />;
  }

  return (
    <RequestListItem
      request={firstUnanswered}
      remainingCount={remainingCount}
      responseText={responses[firstUnanswered.id] ?? ''}
      loading={loading}
      actionRequestId={actionRequestId}
      onSelectAgent={onSelectAgent}
      onClose={onClose}
      onChangeResponse={handleChangeResponse}
      onAccept={handleRespond}
      onSkip={handleSkip}
      onReject={handleReject}
      onSendViaIMessage={handleSendViaIMessage}
    />
  );
}
