import { useState, useCallback } from 'react';

import type { useIntegrationHandlers } from '@/features/integration-handlers-context';

import { createLinkedInSyncAgentApi } from '../api';
import type { MessageSyncType } from '../types';

export function useMessagesSync(
  handlers: ReturnType<typeof useIntegrationHandlers>,
  fetchIntegrations: () => Promise<void>,
) {
  const [messageSyncLoading, setMessageSyncLoading] = useState<MessageSyncType | null>(null);
  const [linkedinSyncLoading, setLinkedinSyncLoading] = useState(false);

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
    setLinkedinSyncLoading(true);
    try {
      await createLinkedInSyncAgentApi();
    } catch (err) {
      console.error('[LinkedIn] Failed to start sync agent:', err);
      throw err;
    } finally {
      setLinkedinSyncLoading(false);
    }
  }, []);

  return {
    messageSyncLoading,
    linkedinSyncLoading,
    handleIMessageSync,
    handleLinkedInSync,
  } as const;
}
