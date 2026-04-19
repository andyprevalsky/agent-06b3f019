/**
 * Single attention-request card rendered inside the inbox modal.
 *
 * Composes: remaining-count indicator, image thumbnail, markdown question,
 * optional iMessage automation block, "View agent" link, response textarea,
 * Skip/Reject/Accept actions, and created-at timestamp.
 */

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MarkdownText } from '../MarkdownText';
import { RequestActionButtons } from './RequestActionButtons';
import { getSendSmsMetadata, type AttentionRequest } from './types';
import { hasIMessageBridge } from './macAppBridge';

interface RequestListItemProps {
  request: AttentionRequest;
  remainingCount: number;
  responseText: string;
  loading: boolean;
  actionRequestId: string | null;
  onSelectAgent?: (agentId: string) => void;
  onClose: () => void;
  onChangeResponse: (requestId: string, text: string) => void;
  onAccept: (requestId: string) => void;
  onSkip: (requestId: string) => void;
  onReject: (requestId: string) => void;
  onSendViaIMessage: (request: AttentionRequest) => void;
}

export function RequestListItem({
  request,
  remainingCount,
  responseText,
  loading,
  actionRequestId,
  onSelectAgent,
  onClose,
  onChangeResponse,
  onAccept,
  onSkip,
  onReject,
  onSendViaIMessage,
}: RequestListItemProps) {
  const sms = getSendSmsMetadata(request.metadata);

  return (
    <div className="space-y-3">
      {remainingCount > 0 && (
        <div className="text-xs text-muted-foreground text-center py-1 px-2 bg-muted/50 rounded">
          {remainingCount} more {remainingCount === 1 ? 'request' : 'requests'} waiting
        </div>
      )}

      {request.image_url && (
        <div className="flex justify-center">
          <img
            src={request.image_url}
            alt="Product thumbnail"
            className="max-w-[200px] max-h-[200px] rounded-md object-contain"
          />
        </div>
      )}

      <div className="max-h-[300px] overflow-y-auto">
        <MarkdownText text={request.question} breaks />
      </div>

      {sms && (
        <IMessageBlock
          to={sms.to}
          message={sms.message}
          loading={loading}
          isSending={actionRequestId === request.id}
          onSend={() => onSendViaIMessage(request)}
        />
      )}

      <Button
        variant="link"
        size="sm"
        className="p-0 h-auto text-xs"
        onClick={() => {
          if (onSelectAgent) {
            onSelectAgent(request.agent_id);
            onClose();
          }
        }}
      >
        View agent →
      </Button>

      <Textarea
        placeholder="Add context (optional)..."
        value={responseText}
        onChange={(e) => onChangeResponse(request.id, e.target.value)}
        className="min-h-[60px]"
      />

      <RequestActionButtons
        requestId={request.id}
        loading={loading}
        onSkip={onSkip}
        onReject={onReject}
        onAccept={onAccept}
      />

      <p className="text-xs text-muted-foreground">
        Asked {new Date(request.created_at).toLocaleString()}
      </p>
    </div>
  );
}

interface IMessageBlockProps {
  to: string;
  message: string;
  loading: boolean;
  isSending: boolean;
  onSend: () => void;
}

function IMessageBlock({ to, message, loading, isSending, onSend }: IMessageBlockProps) {
  const bridgeAvailable = hasIMessageBridge();
  const label = !bridgeAvailable
    ? 'Open Mac app to send'
    : isSending
      ? 'Sending...'
      : 'Send via iMessage';

  return (
    <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-primary">Send via iMessage on your Mac</p>
        <span className="text-xs text-muted-foreground">Requires Mac app</span>
      </div>
      <div className="text-xs text-muted-foreground space-y-1">
        <p>
          <span className="font-semibold">To:</span> {to}
        </p>
        <p className="whitespace-pre-wrap">
          <span className="font-semibold">Message:</span> {message}
        </p>
      </div>
      <Button
        size="sm"
        variant="secondary"
        disabled={isSending || loading || !bridgeAvailable}
        onClick={onSend}
      >
        {label}
      </Button>
    </div>
  );
}
