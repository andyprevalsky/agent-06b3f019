/**
 * STATE MACHINE: useCategoryInputs (adapter — no UI)
 *
 * [integrations-hook state] --assemble--> [CategoryInputs for buildCategories]
 *
 * System context:
 *   OnboardingData composes the shared integrations hooks; this adapter maps
 *   their state + handlers onto the six ring categories and owns the two bits
 *   of onboarding-local state (LinkedIn agent started, WhatsApp/Telegram chat
 *   flows via useOnboardingChat).
 */

import { useCallback, useMemo, useState } from 'react';

import type {
  useBrowserSync,
  useComputeSync,
  useGmailConnect,
  useIntegrationData,
  useMessagesSync,
  usePasswordSync,
} from '@/features/integrations/hooks';
import type { usePlaidIntegration } from '@/features/integrations/hooks/usePlaidIntegration';

import type { CategoryInputs } from './categoryModels';
import { useOnboardingChat, type OnboardingChatState } from './useOnboardingChat';

interface UseCategoryInputsArgs {
  data: ReturnType<typeof useIntegrationData>;
  browser: ReturnType<typeof useBrowserSync>;
  passwords: ReturnType<typeof usePasswordSync>;
  compute: ReturnType<typeof useComputeSync>;
  messages: ReturnType<typeof useMessagesSync>;
  gmail: ReturnType<typeof useGmailConnect>;
  plaid: ReturnType<typeof usePlaidIntegration>;
}

interface AssembleCtx extends UseCategoryInputsArgs {
  chat: OnboardingChatState;
  connectedEmails: string[];
  bankNames: string[];
  linkedInConnected: boolean;
  onLinkedInSync: () => void;
}

/** Fire-and-forget wrapper: onboarding surfaces failures via console only. */
function run(label: string, fn: () => Promise<unknown>): () => void {
  return () => {
    void fn().catch((err: unknown) => console.error(`[OnboardingData] ${label} failed:`, err));
  };
}

function deriveConnectedEmails(data: UseCategoryInputsArgs['data']): string[] {
  const gmail = data.connectedIntegrations.find((i) => i.name === 'gmail');
  if (gmail === undefined || (gmail.status !== 'CONNECTED' && gmail.status !== 'SYNCING')) {
    return [];
  }
  const emails = gmail.config?.connectedEmails ?? [];
  if (emails.length > 0) return emails;
  const single = gmail.config?.connectedEmail;
  return single !== undefined && single !== '' ? [single] : [];
}

function assembleInputs(ctx: AssembleCtx): CategoryInputs {
  const { data, browser, passwords, compute, messages, gmail, plaid, chat } = ctx;
  return {
    browsers: {
      installed: browser.installedBrowsers,
      connected: data.connectedBrowsers,
      loading: browser.browserSyncLoading,
      onSync: (type) => run(`sync ${type}`, () => browser.handleBrowserSync(type))(),
    },
    passwords: {
      chromeSynced: data.chromePasswordsSynced,
      appleSynced: data.applePasswordsSynced || data.passkeysSynced,
      atlasSynced: data.atlasPasswordsSynced,
      loading: passwords.passwordSyncLoading,
      onChromeSync: run('Chrome passwords', passwords.handleChromePasswordsSync),
      onAppleConnect: passwords.openCredentialExchangeModal,
      onAtlasConnect: () => passwords.setAtlasPasswordsModalOpen(true),
    },
    compute: {
      claudeSynced: data.claudeCodeSynced,
      gptSynced: data.gptCodeSynced,
      claudeLoading: compute.claudeCodeSyncLoading,
      gptLoading: compute.gptCodeSyncLoading,
      onClaudeSync: run('Claude sync', compute.handleClaudeCodeSync),
      onGptSync: run('ChatGPT sync', compute.handleGptCodeSync),
    },
    messages: {
      iMessageSynced: data.iMessageSynced,
      whatsAppConnected: data.whatsAppConnected || chat.whatsAppJustConnected,
      telegramConnected: data.telegramConnected || chat.telegramJustConnected,
      connectedEmails: ctx.connectedEmails,
      iMessageLoading: messages.messageSyncLoading === 'imessage',
      chatLoading: chat.chatSyncLoading,
      gmailLoading: gmail.connectingProvider === 'gmail',
      onIMessageSync: run('iMessage sync', messages.handleIMessageSync),
      onWhatsAppConnect: run('WhatsApp connect', chat.handleWhatsAppConnect),
      onTelegramConnect: run('Telegram connect', chat.handleTelegramConnect),
      onGmailConnect: run('Gmail connect', () => gmail.handleEmailConnect('gmail')),
    },
    socials: {
      linkedInStarted: ctx.linkedInConnected,
      linkedInLoading: messages.linkedinSyncLoading,
      onLinkedInSync: ctx.onLinkedInSync,
    },
    financials: {
      bankNames: ctx.bankNames,
      loading: plaid.connectLoading,
      error: plaid.error,
      onConnect: plaid.onConnect,
    },
  };
}

export function useCategoryInputs(args: UseCategoryInputsArgs): {
  inputs: CategoryInputs;
  chat: OnboardingChatState;
} {
  const { data, browser, passwords, compute, messages, gmail, plaid } = args;
  const chat = useOnboardingChat(data.fetchIntegrations);
  const [linkedInStarted, setLinkedInStarted] = useState(false);

  const onLinkedInSync = useCallback((): void => {
    void messages
      .handleLinkedInSync()
      .then(() => setLinkedInStarted(true))
      .catch((err: unknown) => console.error('[OnboardingData] LinkedIn sync failed:', err));
  }, [messages]);

  const connectedEmails = useMemo(() => deriveConnectedEmails(data), [data]);
  const bankNames = useMemo(
    () =>
      plaid.items
        .filter((i) => i.status === 'ACTIVE')
        .map((i) => i.institutionName ?? 'Connected institution'),
    [plaid.items]
  );
  const linkedInConnected =
    linkedInStarted ||
    data.connectedIntegrations.some(
      (i) => i.name === 'linkedin' && i.status === 'CONNECTED' && i.isActive
    );

  const inputs = useMemo<CategoryInputs>(
    () =>
      assembleInputs({
        data,
        browser,
        passwords,
        compute,
        messages,
        gmail,
        plaid,
        chat,
        connectedEmails,
        bankNames,
        linkedInConnected,
        onLinkedInSync,
      }),
    [
      data,
      browser,
      passwords,
      compute,
      messages,
      gmail,
      plaid,
      chat,
      connectedEmails,
      bankNames,
      linkedInConnected,
      onLinkedInSync,
    ]
  );

  return { inputs, chat };
}
