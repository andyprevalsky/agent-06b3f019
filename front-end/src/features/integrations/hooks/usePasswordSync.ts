import { useState, useEffect, useCallback, useRef } from 'react';

import type {
  AutoFillSettingsResult,
  PasskeyImportResult,
  useIntegrationHandlers,
} from '@/features/integration-handlers-context';

import type { PasswordSyncType } from '../types';

const AUTO_FILL_PERMISSION_TIMEOUT_MS = 120_000;
const AUTO_FILL_PERMISSION_POLL_MS = 250;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function usePasswordSync(
  handlers: ReturnType<typeof useIntegrationHandlers>,
  fetchIntegrations: () => Promise<void>,
) {
  const [passwordSyncLoading, setPasswordSyncLoading] = useState<PasswordSyncType | null>(null);
  const [passkeysModalOpen, setPasskeysModalOpen] = useState(false);
  const [atlasPasswordsModalOpen, setAtlasPasswordsModalOpen] = useState(false);
  const pendingPasskeyImport = useRef<{
    resolve: (result: PasskeyImportResult) => void;
    reject: (error: Error) => void;
    timeoutId: number;
  } | null>(null);

  const finishPendingPasskeyImport = useCallback((result: PasskeyImportResult) => {
    const pending = pendingPasskeyImport.current;
    if (pending === null) return;

    window.clearTimeout(pending.timeoutId);
    pendingPasskeyImport.current = null;

    const importedPasskeys = result.passkeyCount ?? result.count ?? 0;
    const importedPasswords = result.passwordCount ?? 0;
    if (result.success && (importedPasskeys > 0 || importedPasswords > 0)) {
      pending.resolve(result);
      return;
    }

    pending.reject(new Error(result.message ?? 'No credentials were transferred'));
  }, []);

  const waitForPasskeyImport = useCallback(() => {
    if (pendingPasskeyImport.current !== null) {
      window.clearTimeout(pendingPasskeyImport.current.timeoutId);
      pendingPasskeyImport.current.reject(new Error('A newer Apple Passwords sync was started'));
      pendingPasskeyImport.current = null;
    }

    return new Promise<PasskeyImportResult>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingPasskeyImport.current = null;
        reject(new Error('Apple Passwords did not send Rose an import token'));
      }, 120_000);
      pendingPasskeyImport.current = { resolve, reject, timeoutId };
    });
  }, []);

  const waitForAutoFillEnabled = useCallback(
    async (initialResult: AutoFillSettingsResult): Promise<AutoFillSettingsResult> => {
      if (initialResult.enabled === true) {
        return initialResult;
      }
      if (!handlers.passkeys?.checkAutoFillSettings) {
        throw new Error('Enable Rose in AutoFill, then click Sync again');
      }

      const deadline = Date.now() + AUTO_FILL_PERMISSION_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await wait(AUTO_FILL_PERMISSION_POLL_MS);
        const status = await handlers.passkeys.checkAutoFillSettings();
        if (status.success && status.enabled === true) {
          return status;
        }
      }

      throw new Error('Timed out waiting for Rose AutoFill permission');
    },
    [handlers.passkeys],
  );

  useEffect(() => {
    return handlers.passkeys?.onImportComplete?.((result) => {
      const importedPasskeys = result.passkeyCount ?? result.count ?? 0;
      const importedPasswords = result.passwordCount ?? 0;
      if (result.success && (importedPasskeys > 0 || importedPasswords > 0)) {
        setPasskeysModalOpen(false);
      }
      finishPendingPasskeyImport(result);
      setPasswordSyncLoading(null);
      void fetchIntegrations();
    });
  }, [finishPendingPasskeyImport, handlers.passkeys, fetchIntegrations]);

  useEffect(() => {
    return () => {
      if (pendingPasskeyImport.current !== null) {
        window.clearTimeout(pendingPasskeyImport.current.timeoutId);
        pendingPasskeyImport.current.reject(new Error('Apple Passwords sync was cancelled'));
        pendingPasskeyImport.current = null;
      }
    };
  }, []);

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
