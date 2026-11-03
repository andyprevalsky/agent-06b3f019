import { useState, useEffect, useCallback } from 'react';

import type { BrowserType } from '@/features/integration-handlers-context';

import { fetchIntegrationsListApi } from '../api/accounts';
import { VALID_BROWSER_TYPES } from '../config';
import type { AccountsByProvider, ConnectedIntegration, EmailCredentialState } from '../types';

interface IntegrationSyncState {
  connectedIntegrations: ConnectedIntegration[];
  connectedBrowsers: Set<BrowserType>;
  chromePasswordsSynced: boolean;
  applePasswordsSynced: boolean;
  passkeysSynced: boolean;
  atlasPasswordsSynced: boolean;
  claudeCodeSynced: boolean;
  gptCodeSynced: boolean;
  iMessageSynced: boolean;
  whatsAppConnected: boolean;
  telegramConnected: boolean;
  /** LinkedIn export sync: SYNCING while its export agent runs, CONNECTED once uploaded. */
  linkedinStatus: ConnectedIntegration['status'] | null;
}

export interface GmailAccountView {
  email: string;
  state: EmailCredentialState;
  lastErrorReason: string | null;
}

/**
 * The connected Gmail addresses and their individual health.
 *
 * Prefers `emailCredentials`, which is the only source that says WHICH address
 * broke. Falls back to the flat `config.connectedEmails` list (all assumed
 * healthy) so a backend that predates per-account health still renders chips
 * rather than an empty row.
 *
 * Credentials with no email are dropped: they are half-finished OAuth attempts,
 * not accounts the user recognises, and showing a blank chip that cannot be
 * reconnected would be worse than showing nothing.
 */
export function gmailAccounts(gmail: ConnectedIntegration | undefined): GmailAccountView[] {
  const credentials = gmail?.emailCredentials;
  if (credentials !== undefined && credentials.length > 0) {
    return credentials
      .filter((c): c is typeof c & { email: string } => c.email !== null && c.email !== '')
      .map((c) => ({
        email: c.email,
        state: c.state,
        lastErrorReason: c.lastErrorReason,
      }));
  }

  const legacy =
    gmail?.config?.connectedEmails ??
    (gmail?.config?.connectedEmail ? [gmail.config.connectedEmail] : []);
  return (legacy as string[]).map((email) => ({
    email,
    state: 'connected' as const,
    lastErrorReason: null,
  }));
}

/** True when at least one connected email account needs the user's attention. */
export function hasDamagedGmailAccount(integrations: ConnectedIntegration[]): boolean {
  const gmail = integrations.find((i) => i.name === 'gmail');
  return gmailAccounts(gmail).some((a) => a.state !== 'connected');
}

function deriveStateFromIntegrations(integrations: ConnectedIntegration[]): IntegrationSyncState {
  const connectedBrowsers = new Set<BrowserType>();
  for (const integration of integrations) {
    if (VALID_BROWSER_TYPES.includes(integration.name as BrowserType)) {
      connectedBrowsers.add(integration.name as BrowserType);
    }
  }

  const isConnected = (integration: ConnectedIntegration) =>
    integration.status === 'CONNECTED' && integration.isActive;
  const find = (name: string) => integrations.some((i) => i.name === name && isConnected(i));

  return {
    connectedIntegrations: integrations,
    connectedBrowsers,
    chromePasswordsSynced: integrations.some(
      (i) => i.name === 'chrome_passwords' || i.name === 'chrome',
    ),
    applePasswordsSynced: find('apple_passwords'),
    passkeysSynced: integrations.some((i) => isConnected(i) && i.name.endsWith('_passkeys')),
    atlasPasswordsSynced: find('atlas_passwords'),
    claudeCodeSynced: find('claude_code'),
    gptCodeSynced: find('gpt_code'),
    iMessageSynced: find('imessage'),
    whatsAppConnected: find('whatsapp'),
    telegramConnected: find('telegram'),
    linkedinStatus: integrations.find((i) => i.name === 'linkedin')?.status ?? null,
  };
}

export function useIntegrationData() {
  const [loadingIntegrations, setLoadingIntegrations] = useState(true);
  const [syncState, setSyncState] = useState<IntegrationSyncState>({
    connectedIntegrations: [],
    connectedBrowsers: new Set(),
    chromePasswordsSynced: false,
    applePasswordsSynced: false,
    passkeysSynced: false,
    atlasPasswordsSynced: false,
    claudeCodeSynced: false,
    gptCodeSynced: false,
    iMessageSynced: false,
    whatsAppConnected: false,
    telegramConnected: false,
    linkedinStatus: null,
  });
  // Rose Desktop reads per-provider accounts (incl. progress-only providers) from here.
  const [accountsByProvider, setAccountsByProvider] = useState<AccountsByProvider | null>(null);

  const fetchIntegrations = useCallback(async () => {
    try {
      const list = await fetchIntegrationsListApi();
      setSyncState(deriveStateFromIntegrations(list.integrations));
      setAccountsByProvider(list.accountsByProvider);
    } catch (err) {
      console.error('Failed to fetch integrations:', err);
    } finally {
      setLoadingIntegrations(false);
    }
  }, []);

  useEffect(() => {
    void fetchIntegrations();
  }, [fetchIntegrations]);

  return { loadingIntegrations, ...syncState, accountsByProvider, fetchIntegrations } as const;
}
