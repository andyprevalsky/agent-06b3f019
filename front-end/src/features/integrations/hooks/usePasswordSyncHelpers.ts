import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';

import type { PasswordSyncType } from '../types';

interface PasskeyImportResult {
  success: boolean;
  count?: number;
  passkeyCount?: number;
  passwordCount?: number;
  message?: string;
}

interface AutoFillSettingsResult {
  success: boolean;
  enabled?: boolean;
  credentialExchangeEnabled?: boolean;
  openedSettings?: boolean;
  openedPasswordsApp?: boolean;
  message?: string;
}

interface PasskeysHandler {
  checkAutoFillSettings?: () => Promise<AutoFillSettingsResult>;
  onImportComplete?: (callback: (result: PasskeyImportResult) => void) => () => void;
}

interface BrowserCookiesHandler {
  syncBrowserPasswords: (browserType: 'chrome') => Promise<{ success: boolean; message?: string }>;
}

const AUTO_FILL_PERMISSION_TIMEOUT_MS = 120_000;
const AUTO_FILL_PERMISSION_POLL_MS = 250;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function usePendingPasskeyImport() {
  const pendingImport = useRef<{
    resolve: (result: PasskeyImportResult) => void;
    reject: (error: Error) => void;
    timeoutId: number;
  } | null>(null);

  const finish = useCallback((result: PasskeyImportResult) => {
    const pending = pendingImport.current;
    if (pending === null) return;
    window.clearTimeout(pending.timeoutId);
    pendingImport.current = null;
    const importedPasskeys = result.passkeyCount ?? result.count ?? 0;
    const importedPasswords = result.passwordCount ?? 0;
    if (result.success && (importedPasskeys > 0 || importedPasswords > 0)) {
      pending.resolve(result);
      return;
    }
    pending.reject(new Error(result.message ?? 'No credentials were transferred'));
  }, []);

  const waitForImport = useCallback(() => {
    if (pendingImport.current !== null) {
      window.clearTimeout(pendingImport.current.timeoutId);
      pendingImport.current.reject(new Error('A newer Apple Passwords sync was started'));
      pendingImport.current = null;
    }
    return new Promise<PasskeyImportResult>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingImport.current = null;
        reject(new Error('Apple Passwords did not send Rose an import token'));
      }, 120_000);
      pendingImport.current = { resolve, reject, timeoutId };
    });
  }, []);

  useEffect(
    () => () => {
      if (pendingImport.current === null) return;
      window.clearTimeout(pendingImport.current.timeoutId);
      pendingImport.current.reject(new Error('Apple Passwords sync was cancelled'));
      pendingImport.current = null;
    },
    [],
  );
  return { finish, waitForImport };
}

export function useAutoFillPermission(passkeys: PasskeysHandler | undefined) {
  return useCallback(
    async (initialResult: AutoFillSettingsResult): Promise<AutoFillSettingsResult> => {
      if (initialResult.enabled === true) return initialResult;
      if (!passkeys?.checkAutoFillSettings) {
        throw new Error('Enable Rose in AutoFill, then click Sync again');
      }
      const deadline = Date.now() + AUTO_FILL_PERMISSION_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await wait(AUTO_FILL_PERMISSION_POLL_MS);
        const status = await passkeys.checkAutoFillSettings();
        if (status.success && status.enabled === true) return status;
      }
      throw new Error('Timed out waiting for Rose AutoFill permission');
    },
    [passkeys],
  );
}

export function usePasskeyImportListener(
  passkeys: PasskeysHandler | undefined,
  finish: (result: PasskeyImportResult) => void,
  fetchIntegrations: () => Promise<void>,
  setModalOpen: Dispatch<SetStateAction<boolean>>,
  setLoading: Dispatch<SetStateAction<PasswordSyncType | null>>,
) {
  useEffect(() => {
    return passkeys?.onImportComplete?.((result) => {
      const importedPasskeys = result.passkeyCount ?? result.count ?? 0;
      const importedPasswords = result.passwordCount ?? 0;
      if (result.success && (importedPasskeys > 0 || importedPasswords > 0)) setModalOpen(false);
      finish(result);
      setLoading(null);
      void fetchIntegrations();
    });
  }, [fetchIntegrations, finish, passkeys, setLoading, setModalOpen]);
}

export function useChromePasswordSync(
  browserCookies: BrowserCookiesHandler | undefined,
  fetchIntegrations: () => Promise<void>,
  setLoading: Dispatch<SetStateAction<PasswordSyncType | null>>,
) {
  return useCallback(async () => {
    if (!browserCookies) return;
    setLoading('chrome');
    try {
      await browserCookies.syncBrowserPasswords('chrome');
      await fetchIntegrations();
    } finally {
      setLoading(null);
    }
  }, [browserCookies, fetchIntegrations, setLoading]);
}
