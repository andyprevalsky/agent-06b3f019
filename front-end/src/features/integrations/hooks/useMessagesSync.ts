import { useState, useCallback } from 'react';

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

  const handleIMessageSync = useCallback(async () => {
    if (!handlers.iMessage?.isAvailable) return;
    setMessageSyncLoading('imessage');
    try {
      await handlers.iMessage.onClick();
      await fetchIntegrations();
    } finally {
      setMessageSyncLoading(null);
    }
  }, [handlers.iMessage, fetchIntegrations]);

  const handleLinkedInSync = useCallback(async () => {
    // Only ever spawn one export agent -- re-exporting would duplicate the work.
    if (linkedinSyncStarted) return;
    setLinkedinSyncLoading(true);
    try {
      await createLinkedInSyncAgentApi();
      setLinkedinSyncStarted(true);
      toast({
        title: 'Agent spawned',
        description: 'An agent was spawned to connect your LinkedIn data.',
      });
    } catch (err) {
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
    handleLinkedInSync,
  } as const;
}
