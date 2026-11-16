/**
 * STATE MACHINE: RequestListItem
 *
 * [GENERIC_REQUEST]
 *   | render optional media / question / response text
 *   v
 * [GENERIC_ACTIONS] -- Accept/Skip/Reject --> parent action handler
 *
 * [NATIVE AUTH] -> exact request/task locator; authenticated fullscreen resolves authority.
 * [NATIVE AUTH] --Resend code--> typed resend completion; agent re-raises a new request.
 * [AUTH_ASSISTANCE]
 *   | Open Live Browser selects the agent and fullscreen-opens the browser task
 *   v
 * [LIVE_VIEW_FULLSCREEN]
 */

import type { PhoneAttentionTarget } from '@/lib/api/phoneAttention';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Maximize2 } from 'lucide-react';
import { MarkdownText } from '../MarkdownText';
import { RequestActionButtons } from './RequestActionButtons';
import { GateRequestCard } from './GateRequestCard';
import { runGateConnectAction } from './gateConnect';
import {
  getAuthAssistanceMetadata,
  getGateMetadata,
  getSendSmsMetadata,
  type AttentionRequest,
} from './types';
import { hasIMessageBridge } from './macAppBridge';
import { PhoneResendCodeButton } from '../browser-status-bar/phone/PhoneResendCodeButton';

interface RequestListItemProps {
  request: AttentionRequest;
  remainingCount: number;
  responseText: string;
  loading: boolean;
  actionRequestId: string | null;
  onSelectAgent?: (agentId: string) => void;
  onClose: () => void;
  onChangeResponse: (requestId: string, text: string) => void;
  onAccept: (requestId: string, overrideResponse?: string) => void;
  onSkip: (requestId: string) => void;
  onReject: (requestId: string) => void;
  onSendViaIMessage: (request: AttentionRequest) => void;
}

export function RequestListItem(props: RequestListItemProps) {
  const { request, remainingCount, onSelectAgent, onClose } = props;

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

      <RequestBody {...props} />

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

      <p className="text-xs text-muted-foreground">
        Asked {new Date(request.created_at).toLocaleString()}
      </p>
    </div>
  );
}

/** Gate requests render the Gate card; everything else uses the generic body. */
function RequestBody(props: RequestListItemProps) {
  const { request, loading, onAccept, onReject } = props;
  const gate = getGateMetadata(request.metadata);
  if (!gate) return <GenericRequestBody {...props} />;

  return (
    <GateRequestCard
      gate={gate}
      loading={loading}
      onPrimary={() => {
        if (gate.action.kind === 'link') {
          void runGateConnectAction(gate, { requestId: request.id });
          return;
        }
        const reply = gate.action.tokens[0] ?? 'YES';
        onAccept(request.id, reply);
      }}
      onCancel={() => onReject(request.id)}
    />
  );
}

function GenericRequestBody({
  request,
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
  const authAssistance = getAuthAssistanceMetadata(request);

  return (
    <>
      <div className="max-h-[300px] overflow-y-auto">
        <MarkdownText text={request.question} breaks />
      </div>

      {authAssistance ? (
        <AuthAssistanceBlock
          authRealm={authAssistance.authRealm}
          liveViewUrl={authAssistance.liveViewUrl}
          target={authAssistance.target}
          agentId={request.agent_id}
          requestId={request.id}
          loading={loading}
          isCompleting={actionRequestId === request.id}
          onOpenLiveView={() => {
            openAuthBrowserInApp({
              agentId: request.agent_id,
              browserId:
                authAssistance.target?.browserTaskId ??
                authAssistance.browserSessionId ??
                authAssistance.taskId,
              requestId: authAssistance.target ? request.id : undefined,
              onSelectAgent,
              onClose,
            });
          }}
        />
      ) : null}

      {!authAssistance && sms && (
        <IMessageBlock
          to={sms.to}
          message={sms.message}
          loading={loading}
          isSending={actionRequestId === request.id}
          onSend={() => onSendViaIMessage(request)}
        />
      )}

      {!authAssistance && (
        <>
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
        </>
      )}
    </>
  );
}

function openAuthBrowserInApp({
  agentId,
  browserId,
  requestId,
  onSelectAgent,
  onClose,
}: {
  agentId: string;
  browserId: string | undefined;
  requestId?: string;
  onSelectAgent?: (agentId: string) => void;
  onClose: () => void;
}) {
  onSelectAgent?.(agentId);
  const url = new URL(window.location.href);
  url.searchParams.set('agent-id', agentId);
  if (requestId) url.searchParams.set('attention-request-id', requestId);
  else url.searchParams.delete('attention-request-id');
  if (browserId) {
    url.searchParams.set('browser-id', browserId);
  }
  window.history.replaceState({}, '', url.toString());
  if (browserId) {
    window.dispatchEvent(new CustomEvent('navi-open-browser', { detail: { taskId: browserId } }));
  }
  onClose();
}

interface AuthAssistanceBlockProps {
  authRealm?: string;
  liveViewUrl?: string | null;
  target?: PhoneAttentionTarget;
  agentId: string;
  requestId: string;
  loading: boolean;
  isCompleting: boolean;
  onOpenLiveView: () => void;
}

function AuthAssistanceBlock({
  authRealm,
  liveViewUrl,
  target,
  agentId,
  requestId,
  loading,
  isCompleting,
  onOpenLiveView,
}: AuthAssistanceBlockProps) {
  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">Authentication</p>
        {authRealm && <p className="text-xs text-muted-foreground">{authRealm}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={loading || (!liveViewUrl && !target) || isCompleting}
          onClick={onOpenLiveView}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Maximize2 className="mr-2 h-4 w-4" />
          {target ? 'Open phone' : 'Open Live Browser'}
        </Button>
        {target && (
          <PhoneResendCodeButton
            agentId={agentId}
            taskId={target.browserTaskId}
            pendingRequestId={requestId}
            disabled={loading || isCompleting}
            className="inline-flex h-9 items-center gap-1 rounded-md border border-input px-3 text-sm disabled:opacity-50"
          />
        )}
      </div>
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
