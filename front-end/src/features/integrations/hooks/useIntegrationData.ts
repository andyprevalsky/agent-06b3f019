import { useState, useEffect, useCallback } from 'react';

import type { BrowserType } from '@/contexts/IntegrationHandlersContext';

import { fetchIntegrationsApi } from '../api';
import { VALID_BROWSER_TYPES } from '../config';
import type { ConnectedIntegration } from '../types';

interface IntegrationSyncState {
  connectedIntegrations: ConnectedIntegration[];
  connectedBrowsers: Set<BrowserType>;
  chromePasswordsSynced: boolean;
  applePasswordsSynced: boolean;
  atlasPasswordsSynced: boolean;
  claudeCodeSynced: boolean;
  iMessageSynced: boolean;
  whatsAppConnected: boolean;
  telegramConnected: boolean;
}

function deriveStateFromIntegrations(integrations: ConnectedIntegration[]): IntegrationSyncState {
  const connectedBrowsers = new Set<BrowserType>();
  for (const integration of integrations) {
    if (VALID_BROWSER_TYPES.includes(integration.name as BrowserType)) {
      connectedBrowsers.add(integration.name as BrowserType);
    }
  }

  const find = (name: string) => integrations.some((i) => i.name === name);

  return {
    connectedIntegrations: integrations,
    connectedBrowsers,
    chromePasswordsSynced: integrations.some(
      (i) => i.name === 'chrome_passwords' || i.name === 'chrome',
    ),
    applePasswordsSynced: find('apple_passwords'),
    atlasPasswordsSynced: find('atlas_passwords'),
    claudeCodeSynced: find('claude_code'),
    iMessageSynced: find('imessage'),
    whatsAppConnected: find('whatsapp'),
    telegramConnected: find('telegram'),
  };
}

export function useIntegrationData() {
  const [loadingIntegrations, setLoadingIntegrations] = useState(true);
  const [syncState, setSyncState] = useState<IntegrationSyncState>({
    connectedIntegrations: [],
    connectedBrowsers: new Set(),
    chromePasswordsSynced: false,
    applePasswordsSynced: false,
    atlasPasswordsSynced: false,
    claudeCodeSynced: false,
    iMessageSynced: false,
    whatsAppConnected: false,
    telegramConnected: false,
  });

  const fetchIntegrations = useCallback(async () => {
    try {
      const integrations = await fetchIntegrationsApi();
      setSyncState(deriveStateFromIntegrations(integrations));
    } catch (err) {
      console.error('Failed to fetch integrations:', err);
    } finally {
      setLoadingIntegrations(false);
    }
  }, []);

  useEffect(() => {
    void fetchIntegrations();
  }, [fetchIntegrations]);

  return { loadingIntegrations, ...syncState, fetchIntegrations } as const;
}
