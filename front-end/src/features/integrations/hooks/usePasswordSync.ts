import { useState, useCallback } from 'react';

import type { useIntegrationHandlers } from '@/contexts/IntegrationHandlersContext';

import { uploadApplePasswordsApi } from '../api';
import type { PasswordSyncType } from '../types';

export function usePasswordSync(
  handlers: ReturnType<typeof useIntegrationHandlers>,
  fetchIntegrations: () => Promise<void>,
) {
  const [passwordSyncLoading, setPasswordSyncLoading] = useState<PasswordSyncType | null>(null);
  const [applePasswordsModalOpen, setApplePasswordsModalOpen] = useState(false);
  const [atlasPasswordsModalOpen, setAtlasPasswordsModalOpen] = useState(false);

  const handleChromePasswordsSync = useCallback(async () => {
    if (!handlers.browserCookies) return;
    setPasswordSyncLoading('chrome');
    try {
      await handlers.browserCookies.syncBrowserPasswords('chrome');
      await fetchIntegrations();
    } finally {
      setPasswordSyncLoading(null);
    }
  }, [handlers.browserCookies, fetchIntegrations]);

  const handleApplePasswordsSync = useCallback(
    async (file: File) => {
      setPasswordSyncLoading('apple');
      try {
        const payload = await uploadApplePasswordsApi(file);
        setApplePasswordsModalOpen(false);
        await fetchIntegrations();
        return payload.passwordCount;
      } finally {
        setPasswordSyncLoading(null);
      }
    },
    [fetchIntegrations],
  );

  const handleAtlasPasswordsSync = useCallback(
    async (keychainPassword: string) => {
      if (!handlers.browserCookies) return;
      setPasswordSyncLoading('atlas');
      try {
        const result = await handlers.browserCookies.syncBrowserPasswords('atlas', {
          keychainPassword,
        });
        if (!result.success) {
          throw new Error(result.message || 'Failed to sync Atlas passwords');
        }
        setAtlasPasswordsModalOpen(false);
        await fetchIntegrations();
      } finally {
        setPasswordSyncLoading(null);
      }
    },
    [handlers.browserCookies, fetchIntegrations],
  );

  return {
    passwordSyncLoading,
    applePasswordsModalOpen,
    setApplePasswordsModalOpen,
    atlasPasswordsModalOpen,
    setAtlasPasswordsModalOpen,
    handleChromePasswordsSync,
    handleApplePasswordsSync,
    handleAtlasPasswordsSync,
  } as const;
}
