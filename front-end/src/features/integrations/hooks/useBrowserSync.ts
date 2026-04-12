import { useState, useEffect, useCallback } from 'react';

import type {
  useIntegrationHandlers,
  BrowserType,
  BrowserInfo,
} from '@/contexts/IntegrationHandlersContext';

export function useBrowserSync(
  handlers: ReturnType<typeof useIntegrationHandlers>,
  fetchIntegrations: () => Promise<void>,
) {
  const [installedBrowsers, setInstalledBrowsers] = useState<BrowserInfo[]>([]);
  const [browserSyncLoading, setBrowserSyncLoading] = useState<BrowserType | null>(null);
  const [atlasModalOpen, setAtlasModalOpen] = useState(false);
  const [pendingAtlasBrowser, setPendingAtlasBrowser] = useState<BrowserType | null>(null);

  useEffect(() => {
    const fetchBrowsers = async () => {
      if (handlers.browserCookies?.isAvailable) {
        try {
          const browsers = await handlers.browserCookies.getInstalledBrowsers();
          setInstalledBrowsers(browsers);
        } catch (err) {
          console.error('Failed to fetch installed browsers:', err);
        }
      }
    };
    void fetchBrowsers();
  }, [handlers.browserCookies]);

  const handleBrowserSync = useCallback(
    async (browserType: BrowserType) => {
      const browser = installedBrowsers.find((b) => b.type === browserType);
      if (!browser || !handlers.browserCookies) return;

      if (browser.needsManualPassword) {
        setPendingAtlasBrowser(browserType);
        setAtlasModalOpen(true);
        return;
      }

      setBrowserSyncLoading(browserType);
      try {
        await handlers.browserCookies.syncBrowser(browserType);
        await fetchIntegrations();
      } finally {
        setBrowserSyncLoading(null);
      }
    },
    [installedBrowsers, handlers.browserCookies, fetchIntegrations],
  );

  const handleAtlasSync = useCallback(
    async (password: string) => {
      if (!pendingAtlasBrowser || !handlers.browserCookies) return;

      setBrowserSyncLoading(pendingAtlasBrowser);
      try {
        await handlers.browserCookies.syncBrowser(pendingAtlasBrowser, password);
        await handlers.browserCookies.storeAtlasPassword(password);
        setAtlasModalOpen(false);
        setPendingAtlasBrowser(null);
        await fetchIntegrations();
      } finally {
        setBrowserSyncLoading(null);
      }
    },
    [pendingAtlasBrowser, handlers.browserCookies, fetchIntegrations],
  );

  const handleOpenKeychain = useCallback(async () => {
    if (handlers.browserCookies) {
      await handlers.browserCookies.openKeychainAccess('ChatGPT Safe Storage');
    }
  }, [handlers.browserCookies]);

  const closeAtlasModal = useCallback(() => {
    setAtlasModalOpen(false);
    setPendingAtlasBrowser(null);
  }, []);

  return {
    installedBrowsers,
    browserSyncLoading,
    atlasModalOpen,
    handleBrowserSync,
    handleAtlasSync,
    handleOpenKeychain,
    closeAtlasModal,
  } as const;
}
