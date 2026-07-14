import { useState, useCallback } from 'react';

import type { useIntegrationHandlers } from '@/features/integration-handlers-context';

import type { PasswordSyncType } from '../types';
import {
  useAutoFillPermission,
  useChromePasswordSync,
  usePasskeyImportListener,
  usePendingPasskeyImport,
} from './usePasswordSyncHelpers';

export function usePasswordSync(
  handlers: ReturnType<typeof useIntegrationHandlers>,
  fetchIntegrations: () => Promise<void>,
) {
  const [passwordSyncLoading, setPasswordSyncLoading] = useState<PasswordSyncType | null>(null);
  const [passkeysModalOpen, setPasskeysModalOpen] = useState(false);
  const [atlasPasswordsModalOpen, setAtlasPasswordsModalOpen] = useState(false);
  const { finish: finishPendingPasskeyImport, waitForImport: waitForPasskeyImport } =
    usePendingPasskeyImport();
  const waitForAutoFillEnabled = useAutoFillPermission(handlers.passkeys);

  usePasskeyImportListener(
    handlers.passkeys,
    finishPendingPasskeyImport,
    fetchIntegrations,
    setPasskeysModalOpen,
    setPasswordSyncLoading,
  );
  const handleChromePasswordsSync = useChromePasswordSync(
    handlers.browserCookies,
    fetchIntegrations,
    setPasswordSyncLoading,
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

  const openCredentialExchangeModal = useCallback(() => {
    setPasskeysModalOpen(true);
  }, []);

  const handlePasskeysConnect = useCallback(async () => {
    if (!handlers.passkeys?.openAutoFillSettings) return;
    setPasswordSyncLoading('passkeys');
    try {
      const result = await handlers.passkeys.openAutoFillSettings();
      if (!result.success) {
        throw new Error(result.message ?? 'Failed to open AutoFill settings');
      }
      const enabledResult = await waitForAutoFillEnabled(result);
      if (handlers.passkeys.openPasswordsApp) {
        const passwordsResult = await handlers.passkeys.openPasswordsApp();
        if (!passwordsResult.success) {
          throw new Error(passwordsResult.message ?? 'Failed to open Apple Passwords');
        }
        await waitForPasskeyImport();
        return { ...enabledResult, openedPasswordsApp: true };
      }
      throw new Error('Desktop bridge could not open Apple Passwords');
    } finally {
      setPasswordSyncLoading(null);
    }
  }, [handlers.passkeys, waitForAutoFillEnabled, waitForPasskeyImport]);

  return {
    passwordSyncLoading,
    passkeysModalOpen,
    setPasskeysModalOpen,
    openCredentialExchangeModal,
    atlasPasswordsModalOpen,
    setAtlasPasswordsModalOpen,
    handleChromePasswordsSync,
    handleAtlasPasswordsSync,
    handlePasskeysConnect,
  } as const;
}
