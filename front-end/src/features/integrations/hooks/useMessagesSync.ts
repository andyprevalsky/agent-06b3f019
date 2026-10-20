import { useState, useCallback, useEffect, useRef } from 'react';

import type { useIntegrationHandlers } from '@/features/integration-handlers-context';
import { toast } from '@/hooks/use-toast';

import { createLinkedInSyncAgentApi } from '../api/linkedin';
import type { ConnectedIntegration, MessageSyncType } from '../types';

/** How often a running LinkedIn sync re-reads its state, so the row settles when the agent ends. */
export const LINKEDIN_SYNC_REFRESH_MS = 15_000;

export function useMessagesSync(
  handlers: ReturnType<typeof useIntegrationHandlers>,
  fetchIntegrations: () => Promise<void>,
  linkedinStatus: ConnectedIntegration['status'] | null,
) {
  const [messageSyncLoading, setMessageSyncLoading] = useState<MessageSyncType | null>(null);
  const [linkedinSyncLoading, setLinkedinSyncLoading] = useState(false);
  // The server's LinkedIn row is the only source of truth: it survives refresh
  // and reads as SYNC_FAILED once the export agent ends without uploading.
  const linkedinSyncStarted = linkedinStatus === 'SYNCING';
  const linkedinConnected = linkedinStatus === 'CONNECTED';
  // Server state only flips AFTER the create call resolves, so two rapid clicks
  // could both pass that guard and spawn duplicate export agents. This ref is
  // set synchronously to close the in-flight window.
  const linkedinSyncInFlight = useRef(false);

  useEffect(() => {
    if (!linkedinSyncStarted) return;
    const id = setInterval(() => void fetchIntegrations(), LINKEDIN_SYNC_REFRESH_MS);
    return () => clearInterval(id);
  }, [linkedinSyncStarted, fetchIntegrations]);
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
    if (linkedinSyncInFlight.current || linkedinSyncStarted || linkedinConnected) return;
    linkedinSyncInFlight.current = true;
    setLinkedinSyncLoading(true);
    try {
      await createLinkedInSyncAgentApi();
      await fetchIntegrations();
      toast({
        title: 'Agent spawned',
        description: 'An agent was spawned to connect your LinkedIn data.',
      });
    } catch (err) {
      console.error('[LinkedIn] Failed to start sync agent:', err);
      throw err;
    } finally {
      // The server row now blocks re-export while the agent runs; a failed
      // spawn leaves it unchanged and retryable.
      linkedinSyncInFlight.current = false;
      setLinkedinSyncLoading(false);
    }
  }, [linkedinSyncStarted, linkedinConnected, fetchIntegrations]);

  return {
    messageSyncLoading,
    linkedinSyncLoading,
    linkedinSyncStarted,
    linkedinConnected,
    handleIMessageSync,
    handleWhatsAppConnect,
    handleLinkedInSync,
  } as const;
}
