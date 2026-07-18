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

import { useCallback, useMemo, useRef, useState } from 'react';

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

interface UseCategoryInputsResult {
  inputs: CategoryInputs;
  chat: OnboardingChatState;
}

interface AssembleCtx extends UseCategoryInputsArgs {
  chat: OnboardingChatState;
  connectedEmails: string[];
  bankNames: string[];
  linkedInConnected: boolean;
  onLinkedInSync: () => void;
  operationErrors: OperationErrors;
  operationGenerations: OperationGenerations;
  setOperationError: SetOperationError;
}

type OperationCategory = 'browsers' | 'passwords' | 'compute' | 'messages' | 'socials';
type OperationErrors = Record<OperationCategory, string | null>;
type OperationGenerations = Record<OperationCategory, number>;
type SetOperationError = (category: OperationCategory, error: string | null) => void;

const INITIAL_OPERATION_ERRORS: OperationErrors = {
  browsers: null,
  passwords: null,
  compute: null,
  messages: null,
  socials: null,
};

function initialOperationGenerations(): OperationGenerations {
  return { browsers: 0, passwords: 0, compute: 0, messages: 0, socials: 0 };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback;
}

/** Fire-and-forget wrapper that reports rejected connector operations in-card. */
function run(
  category: OperationCategory,
  label: string,
  fn: () => Promise<unknown>,
  operationGenerations: OperationGenerations,
  setOperationError: SetOperationError
): () => void {
  return () => {
    const generation = ++operationGenerations[category];
    setOperationError(category, null);
    void fn().catch((err: unknown) => {
      console.error(`[OnboardingData] ${label} failed:`, err);
      if (generation === operationGenerations[category]) {
        setOperationError(category, errorMessage(err, `${label} failed. Please try again.`));
      }
    });
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
  const { operationErrors, operationGenerations, setOperationError } = ctx;
  const runFor = (category: OperationCategory, label: string, fn: () => Promise<unknown>) =>
    run(category, label, fn, operationGenerations, setOperationError);
  return {
    browsers: {
      installed: browser.installedBrowsers,
      connected: data.connectedBrowsers,
      loading: browser.browserSyncLoading,
      error: operationErrors.browsers,
      onSync: (type) => runFor('browsers', `Sync ${type}`, () => browser.handleBrowserSync(type))(),
    },
    passwords: {
      chromeSynced: data.chromePasswordsSynced,
      appleSynced: data.applePasswordsSynced || data.passkeysSynced,
      atlasSynced: data.atlasPasswordsSynced,
      loading: passwords.passwordSyncLoading,
      error: operationErrors.passwords,
      onChromeSync: runFor('passwords', 'Chrome passwords', passwords.handleChromePasswordsSync),
      onAppleConnect: passwords.openCredentialExchangeModal,
      onAtlasConnect: () => passwords.setAtlasPasswordsModalOpen(true),
    },
    compute: {
      claudeSynced: data.claudeCodeSynced,
      gptSynced: data.gptCodeSynced,
      claudeLoading: compute.claudeCodeSyncLoading,
      gptLoading: compute.gptCodeSyncLoading,
      error: operationErrors.compute,
      onClaudeSync: runFor('compute', 'Claude sync', compute.handleClaudeCodeSync),
      onGptSync: runFor('compute', 'ChatGPT sync', compute.handleGptCodeSync),
    },
    messages: {
      iMessageSynced: data.iMessageSynced,
      whatsAppConnected: data.whatsAppConnected || chat.whatsAppJustConnected,
      telegramConnected: data.telegramConnected || chat.telegramJustConnected,
      connectedEmails: ctx.connectedEmails,
      iMessageLoading: messages.messageSyncLoading === 'imessage',
      chatLoading: chat.chatSyncLoading,
      gmailLoading: gmail.connectingProvider === 'gmail',
      error: operationErrors.messages,
      onIMessageSync: runFor('messages', 'iMessage sync', messages.handleIMessageSync),
      onWhatsAppConnect: runFor('messages', 'WhatsApp connect', chat.handleWhatsAppConnect),
      onTelegramConnect: runFor('messages', 'Telegram connect', chat.handleTelegramConnect),
      onGmailConnect: runFor('messages', 'Gmail connect', () => gmail.handleEmailConnect('gmail')),
    },
    socials: {
      linkedInStarted: ctx.linkedInConnected,
      linkedInLoading: messages.linkedinSyncLoading,
      error: operationErrors.socials,
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

export function useCategoryInputs(args: UseCategoryInputsArgs): UseCategoryInputsResult {
  const { data, browser, passwords, compute, messages, gmail, plaid } = args;
  const chat = useOnboardingChat(data.fetchIntegrations);
  const [linkedInStarted, setLinkedInStarted] = useState(false);
  const [operationErrors, setOperationErrors] = useState<OperationErrors>(INITIAL_OPERATION_ERRORS);
  const operationGenerationsRef = useRef<OperationGenerations>(initialOperationGenerations());
  const setOperationError = useCallback<SetOperationError>((category, error) => {
    setOperationErrors((current) => ({ ...current, [category]: error }));
  }, []);

  const onLinkedInSync = useCallback((): void => {
    const generation = ++operationGenerationsRef.current.socials;
    setOperationError('socials', null);
    void messages.handleLinkedInSync().then(
      () => {
        if (generation === operationGenerationsRef.current.socials) setLinkedInStarted(true);
      },
      (err: unknown) => {
        console.error('[OnboardingData] LinkedIn sync failed:', err);
        if (generation === operationGenerationsRef.current.socials) {
          setOperationError(
            'socials',
            errorMessage(err, 'LinkedIn sync failed. Please try again.')
          );
        }
      }
    );
  }, [messages, setOperationError]);

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
        operationErrors,
        operationGenerations: operationGenerationsRef.current,
        setOperationError,
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
      operationErrors,
      setOperationError,
    ]
  );

  return { inputs, chat };
}
