import { useState, useCallback, useRef } from 'react';

import type { useIntegrationHandlers } from '@/features/integration-handlers-context';
import { toast } from '@/hooks/use-toast';

import { createLinkedInSyncAgentApi } from '../api';
import type { MessageSyncType } from '../types';

export function useMessagesSync(
  handlers: ReturnType<typeof useIntegrationHandlers>,
  fetchIntegrations: () => Promise<void>,
) {
  const [messageSyncLoading, setMessageSyncLoading] = useState<MessageSyncType | null>(null);
  const [linkedinSyncLoading, setLinkedinSyncLoading] = useState(false);
  const [linkedinSyncStarted, setLinkedinSyncStarted] = useState(false);
  // `linkedinSyncStarted` is React state and only flips AFTER the create call
  // resolves, so two rapid clicks could both pass that guard and spawn duplicate
  // export agents. This ref is set synchronously to close the in-flight window.
  const linkedinSyncInFlight = useRef(false);
  // iMessage and WhatsApp share one `messageSyncLoading` slot, so without a guard
  // the second start overwrites the first's label and the first `finally` clears
  // the row while the other native operation is still running -- re-exposing the
  // action mid-flight and allowing a duplicate native call. Set synchronously
  // (state flips a tick too late to close the window).
  const messageSyncInFlight = useRef(false);

  const handleIMessageSync = useCallback(async () => {
    if (messageSyncInFlight.current || !handlers.iMessage?.isAvailable) return;
    messageSyncInFlight.current = true;
    setMessageSyncLoading('imessage');
    try {
      await handlers.iMessage.onClick();
      await fetchIntegrations();
    } finally {
      messageSyncInFlight.current = false;
      setMessageSyncLoading(null);
    }
  }, [handlers.iMessage, fetchIntegrations]);

  // Pairing (QR display included) is owned by the desktop shell; this only drives
  // the row's loading state and refreshes once pairing settles.
  const handleWhatsAppConnect = useCallback(async () => {
    if (messageSyncInFlight.current || !handlers.whatsApp?.isAvailable) return;
    messageSyncInFlight.current = true;
    setMessageSyncLoading('whatsapp');
    try {
      const result = await handlers.whatsApp.connect();
      if (!result.success) {
        throw new Error(result.error ?? 'WhatsApp connection failed. Please try again.');
      }
      await fetchIntegrations();
    } finally {
      messageSyncInFlight.current = false;
      setMessageSyncLoading(null);
    }
  }, [handlers.whatsApp, fetchIntegrations]);

  const handleLinkedInSync = useCallback(async () => {
    // Only ever spawn one export agent -- re-exporting would duplicate the work.
    if (linkedinSyncInFlight.current || linkedinSyncStarted) return;
    linkedinSyncInFlight.current = true;
    setLinkedinSyncLoading(true);
    try {
      await createLinkedInSyncAgentApi();
      setLinkedinSyncStarted(true);
      toast({
        title: 'Agent spawned',
        description: 'An agent was spawned to connect your LinkedIn data.',
      });
    } catch (err) {
      // Release the guard so a failed spawn stays retryable; only a successful
      // spawn permanently blocks re-export.
      linkedinSyncInFlight.current = false;
      console.error('[LinkedIn] Failed to start sync agent:', err);
      throw err;
    } finally {
      setLinkedinSyncLoading(false);
    }
  }, [linkedinSyncStarted]);

  return {
    messageSyncLoading,
    linkedinSyncLoading,
    linkedinSyncStarted,
    handleIMessageSync,
    handleWhatsAppConnect,
    handleLinkedInSync,
  } as const;
}
