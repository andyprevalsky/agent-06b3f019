/**
 * STATE MACHINE: useAttentionActions
 *
 * [IDLE]
 *   | respond / skip / reject / send-iMessage
 *   v
 * [MUTATING] -- success --> [REFETCHING] --> [IDLE]
 *      | failure
 *      v
 * [ERROR_TOAST] --> [IDLE]
 * Typed draft bytes are authored input; explicit protocol overrides remain protocol-only.
 */

import { useState } from 'react';
import {
  rejectAttentionRequest,
  respondToAttentionRequest,
  skipAttentionRequest,
  useToast,
} from '../../hooks';
import { getMacAppBridge } from './macAppBridge';
import { getAuthAssistanceMetadata, getSendSmsMetadata, type AttentionRequest } from './types';

type ToastFn = ReturnType<typeof useToast>['toast'];

function countRemaining(requests: AttentionRequest[], excludeId: string): number {
  return requests.filter((r) => !r.answered && r.id !== excludeId).length;
}

function remainingDescription(remaining: number, noneMessage: string): string {
  if (remaining > 0) {
    return `${remaining} more ${remaining === 1 ? 'request' : 'requests'} waiting`;
  }
  return noneMessage;
}

interface ActionSpec {
  requestId: string;
  mutate: () => Promise<void>;
  successToast: { title: string; description: string };
  errorToast: { title: string; description: string };
  keepOpen: boolean;
  /** When false, skip clearing the textarea value for this request. */
  clearInput?: boolean;
}

export interface UseAttentionActionsArgs {
  requests: AttentionRequest[];
  responses: Record<string, string>;
  clearResponse: (requestId: string) => void;
  refetch: () => Promise<void>;
  setIsOpen: (open: boolean) => void;
}

export interface UseAttentionActionsResult {
  loading: boolean;
  actionRequestId: string | null;
  handleRespond: (requestId: string, overrideResponse?: string) => void;
  handleSkip: (requestId: string) => void;
  handleReject: (requestId: string) => void;
  handleSendViaIMessage: (request: AttentionRequest) => void;
}

function useActionRunner(
  clearResponse: (requestId: string) => void,
  refetch: () => Promise<void>,
  setIsOpen: (open: boolean) => void,
  toast: ToastFn,
) {
  const [loading, setLoading] = useState(false);
  const run = async (spec: ActionSpec) => {
    try {
      setLoading(true);
      await spec.mutate();
      if (spec.clearInput !== false) clearResponse(spec.requestId);
      await refetch();
      setIsOpen(spec.keepOpen);
      toast(spec.successToast);
    } catch (error) {
      console.error(`[AttentionInbox] ${spec.errorToast.title}:`, error);
      toast({
        ...spec.errorToast,
        description: error instanceof Error ? error.message : spec.errorToast.description,
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };
  return { loading, run };
}

function skipActionSpec(requests: AttentionRequest[], requestId: string): ActionSpec {
  const remaining = countRemaining(requests, requestId);
  return {
    requestId,
    mutate: () => skipAttentionRequest(requestId),
    successToast: {
      title: 'Request skipped',
      description: remainingDescription(remaining, 'No more pending requests'),
    },
    errorToast: { title: 'Error', description: 'Failed to skip request' },
    keepOpen: true,
  };
}

function createRespondHandler(
  requests: AttentionRequest[],
  responses: Record<string, string>,
  run: (spec: ActionSpec) => Promise<void>,
): UseAttentionActionsResult['handleRespond'] {
  const handleRespond = (requestId: string, overrideResponse?: string) => {
    const request = requests.find((item) => item.id === requestId);
    if (request && getAuthAssistanceMetadata(request)?.target) return;
    const isAuthAssistance = request ? getAuthAssistanceMetadata(request) !== null : false;
    const response =
      overrideResponse ??
      (responses[requestId]?.trim() || (isAuthAssistance ? 'Authentication complete' : 'Approved'));
    const userMessage =
      overrideResponse === undefined && responses[requestId]?.trim()
        ? responses[requestId]
        : undefined;
    const remaining = countRemaining(requests, requestId);
    void run({
      requestId,
      mutate: () => respondToAttentionRequest(requestId, response, userMessage),
      successToast: {
        title: isAuthAssistance ? 'Authentication complete' : 'Response sent',
        description: remainingDescription(
          remaining,
          isAuthAssistance
            ? 'The agent will continue'
            : 'The agent will continue with your response',
        ),
      },
      errorToast: {
        title: 'Error',
        description: isAuthAssistance
          ? 'Failed to complete authentication request'
          : 'Failed to send response',
      },
      keepOpen: isAuthAssistance ? remaining > 0 : true,
      clearInput: !overrideResponse,
    });
  };
  return handleRespond;
}

export function useAttentionActions({
  requests,
  responses,
  clearResponse,
  refetch,
  setIsOpen,
}: UseAttentionActionsArgs): UseAttentionActionsResult {
  const [actionRequestId, setActionRequestId] = useState<string | null>(null);
  const { toast } = useToast();
  const { loading, run } = useActionRunner(clearResponse, refetch, setIsOpen, toast);

  const handleRespond = createRespondHandler(requests, responses, run);

  const handleSkip = (requestId: string) => {
    void run(skipActionSpec(requests, requestId));
  };

  const handleReject = (requestId: string) => {
    const remaining = countRemaining(requests, requestId);
    void run({
      requestId,
      mutate: () =>
        rejectAttentionRequest(
          requestId,
          responses[requestId]?.trim() ? responses[requestId] : undefined,
        ),
      successToast: {
        title: 'Action rejected',
        description: 'The agent will skip this action and continue',
      },
      errorToast: { title: 'Error', description: 'Failed to reject request' },
      keepOpen: remaining > 0,
    });
  };

  const handleSendViaIMessage = (request: AttentionRequest) => {
    void sendViaIMessage(request, setActionRequestId, refetch, toast);
  };

  return {
    loading,
    actionRequestId,
    handleRespond,
    handleSkip,
    handleReject,
    handleSendViaIMessage,
  };
}

async function sendViaIMessage(
  request: AttentionRequest,
  setActionRequestId: (id: string | null) => void,
  refetch: () => Promise<void>,
  toast: ToastFn,
): Promise<void> {
  const sms = getSendSmsMetadata(request.metadata);
  if (!sms) {
    toast({
      title: 'Unsupported action',
      description: 'This request cannot be completed automatically.',
      variant: 'destructive',
    });
    return;
  }

  const bridge = getMacAppBridge();
  if (!bridge?.sendIMessage) {
    toast({
      title: 'Mac app required',
      description: 'Open the Rose Mac app to send this iMessage automatically.',
      variant: 'destructive',
    });
    return;
  }

  try {
    setActionRequestId(request.id);
    const result = await bridge.sendIMessage({ to: sms.to, message: sms.message });
    if (result && result.success === false) {
      throw new Error(result.message || 'iMessage send failed');
    }
    await respondToAttentionRequest(request.id, 'Message sent via Mac app ✅');
    toast({
      title: 'iMessage sent',
      description: 'Your approval was recorded and the agent will continue.',
    });
    await refetch();
  } catch (error) {
    console.error('Failed to send via iMessage:', error);
    toast({
      title: 'Error',
      description: error instanceof Error ? error.message : 'Failed to send via iMessage',
      variant: 'destructive',
    });
  } finally {
    setActionRequestId(null);
  }
}
