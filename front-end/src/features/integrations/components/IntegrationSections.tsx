/**
 * STATE MACHINE: IntegrationSections
 *
 * [MOUNTED] --> renders each section card delegating to domain hooks.
 */

import type { useAccordion } from '../hooks/useAccordion';
import type { useIntegrationData } from '../hooks/useIntegrationData';
import type { useBrowserSync } from '../hooks/useBrowserSync';
import type { usePasswordSync } from '../hooks/usePasswordSync';
import type { useComputeSync } from '../hooks/useComputeSync';
import type { useMessagesSync } from '../hooks/useMessagesSync';
import type { useGmailConnect } from '../hooks/useGmailConnect';
import type { useIntegrationActions } from '../hooks/useIntegrationActions';
import type { usePlaidIntegration } from '../hooks/usePlaidIntegration';

import BrowserCookiesSection from './BrowserCookiesSection';
import PasswordsSection from './PasswordsSection';
import MessagesSyncSection from './MessagesSyncSection';
import ComputeSection from './ComputeSection';
import SocialsSection from './SocialsSection';
import PlaidSection from './PlaidSection';

interface IntegrationSectionsProps {
  isBrowserCookiesAvailable: boolean;
  isPasskeysAvailable: boolean;
  isIMessageAvailable: boolean;
  isClaudeCodeAvailable: boolean;
  isGptCodeAvailable: boolean;
  isFullySignedIn: boolean;
  accordion: ReturnType<typeof useAccordion>;
  data: ReturnType<typeof useIntegrationData>;
  browser: ReturnType<typeof useBrowserSync>;
  passwords: ReturnType<typeof usePasswordSync>;
  compute: ReturnType<typeof useComputeSync>;
  messages: ReturnType<typeof useMessagesSync>;
  gmail: ReturnType<typeof useGmailConnect>;
  actions: ReturnType<typeof useIntegrationActions>;
  plaid: ReturnType<typeof usePlaidIntegration>;
}

function PlaidIntegrationSection({ plaid }: Pick<IntegrationSectionsProps, 'plaid'>) {
  return (
    <PlaidSection
      items={plaid.items}
      itemsLoading={plaid.itemsLoading}
      connectLoading={plaid.connectLoading}
      error={plaid.error}
      onConnect={plaid.onConnect}
    />
  );
}

function ComputeIntegrationSection({
  isClaudeCodeAvailable,
  isGptCodeAvailable,
  accordion,
  data,
  compute,
  actions,
}: Pick<
  IntegrationSectionsProps,
  'isClaudeCodeAvailable' | 'isGptCodeAvailable' | 'accordion' | 'data' | 'compute' | 'actions'
>) {
  return (
    <ComputeSection
      expanded={accordion.computeExpanded}
      onToggle={() => accordion.toggleSection('compute')}
      isClaudeCodeAvailable={isClaudeCodeAvailable}
      isGptCodeAvailable={isGptCodeAvailable}
      claudeCodeSynced={data.claudeCodeSynced}
      gptCodeSynced={data.gptCodeSynced}
      claudeCodeSyncLoading={compute.claudeCodeSyncLoading}
      gptCodeSyncLoading={compute.gptCodeSyncLoading}
      claudeCodeStatus={compute.claudeCodeStatus}
      onClaudeCodeSync={() => void actions.onClaudeCodeSync()}
      onGptCodeSync={() => void actions.onGptCodeSync()}
    />
  );
}

export default function IntegrationSections({
  isBrowserCookiesAvailable,
  isPasskeysAvailable,
  isIMessageAvailable,
  isClaudeCodeAvailable,
  isGptCodeAvailable,
  isFullySignedIn,
  accordion,
  data,
  browser,
  passwords,
  compute,
  messages,
  gmail,
  actions,
  plaid,
}: IntegrationSectionsProps) {
  return (
    <>
      <BrowserCookiesSection
        isAvailable={isBrowserCookiesAvailable}
        expanded={accordion.browsersExpanded}
        onToggle={() => accordion.toggleSection('browsers')}
        installedBrowsers={browser.installedBrowsers}
        connectedBrowsers={data.connectedBrowsers}
        browserSyncLoading={browser.browserSyncLoading}
        onBrowserSync={(bt) => void actions.onBrowserSync(bt)}
      />

      <PasswordsSection
        expanded={accordion.passwordsExpanded}
        onToggle={() => accordion.toggleSection('passwords')}
        isBrowserCookiesAvailable={isBrowserCookiesAvailable}
        isPasskeysAvailable={isPasskeysAvailable}
        chromePasswordsSynced={data.chromePasswordsSynced}
        applePasswordsSynced={data.applePasswordsSynced}
        passkeysSynced={data.passkeysSynced}
        atlasPasswordsSynced={data.atlasPasswordsSynced}
        passwordSyncLoading={passwords.passwordSyncLoading}
        onChromeSync={() => void actions.onChromePasswordsSync()}
        onPasskeysOpen={() => passwords.openCredentialExchangeModal()}
        onAtlasPasswordsOpen={() => passwords.setAtlasPasswordsModalOpen(true)}
      />

      <MessagesSyncSection
        expanded={accordion.messagesSyncExpanded}
        onToggle={() => accordion.toggleSection('messagesSync')}
        isIMessageAvailable={isIMessageAvailable}
        iMessageSynced={data.iMessageSynced}
        messageSyncLoading={messages.messageSyncLoading}
        onIMessageSync={() => void actions.onIMessageSync()}
        connectedIntegrations={data.connectedIntegrations}
        connectingProvider={gmail.connectingProvider}
        onGmailConnect={() => void actions.onGmailConnect()}
      />

      {isFullySignedIn && (
        <ComputeIntegrationSection
          isClaudeCodeAvailable={isClaudeCodeAvailable}
          isGptCodeAvailable={isGptCodeAvailable}
          accordion={accordion}
          data={data}
          compute={compute}
          actions={actions}
        />
      )}

      {isFullySignedIn && <PlaidIntegrationSection plaid={plaid} />}

      <SocialsSection
        expanded={accordion.socialsExpanded}
        onToggle={() => accordion.toggleSection('socials')}
        isBrowserCookiesAvailable={isBrowserCookiesAvailable}
        linkedinSyncLoading={messages.linkedinSyncLoading}
        onLinkedInSync={() => void actions.onLinkedInSync()}
      />
    </>
  );
}
