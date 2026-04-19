/**
 * Handles the click pipeline for "Send via Mac iMessage" on an attention tool
 * card: validates the payload, invokes the Electron bridge, records the
 * approval in the backend, and toasts the result.
 *
 * STATE MACHINE:
 *   [IDLE]                              <-- actionLoading=false
 *      | click
 *      v
 *   [VALIDATING]                        <-- onSuccess / attentionRequestId / bridge / to+message
 *      | valid
 *      v
 *   [SENDING]                           <-- actionLoading=true, bridge.sendIMessage + respond
 *      | success/error
 *      v
 *   [IDLE]                              <-- toast dispatched either way
 */
import { useState } from 'react';
import { respondToAttentionRequest, useToast } from '../../hooks';
import { getMacAppBridge } from './macBridge';

interface AttentionAction {
  onSuccess?: string;
  attentionRequestId?: string;
  to?: string;
  message?: string;
}

export function useSendIMessage(meta: AttentionAction) {
  const [actionLoading, setActionLoading] = useState(false);
  const { toast } = useToast();

  const handleClick = async () => {
    if (meta.onSuccess !== 'sendSmsThroughIMessage') return;
    if (!meta.attentionRequestId) {
      toast({
        title: 'Missing request reference',
        description: 'Open the attention inbox to retry.',
        variant: 'destructive',
      });
      return;
    }

    const bridge = getMacAppBridge();
    if (!bridge?.sendIMessage) {
      toast({
        title: 'Mac app required',
        description: 'Open the Rose Mac app to send this message automatically.',
        variant: 'destructive',
      });
      return;
    }

    const { to, message } = meta;
    if (!to || !message) {
      toast({
        title: 'Missing details',
        description: 'Recipient or message is missing from this request.',
        variant: 'destructive',
      });
      return;
    }

    try {
      setActionLoading(true);
      const result = await bridge.sendIMessage({ to, message });
      if (result && result.success === false) {
        throw new Error(result.message || 'iMessage send failed');
      }
      await respondToAttentionRequest(meta.attentionRequestId, 'Message sent via Mac app ✅');
      toast({
        title: 'iMessage sent',
        description: 'Approval recorded. Check the attention inbox for updates.',
      });
    } catch (error) {
      console.error('Failed to send via iMessage from message bubble:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to send via iMessage',
        variant: 'destructive',
      });
    } finally {
      setActionLoading(false);
    }
  };

  return { actionLoading, handleClick };
}

export type { AttentionAction };
