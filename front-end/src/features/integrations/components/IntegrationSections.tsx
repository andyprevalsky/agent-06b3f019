/**
 * STATE MACHINE: IntegrationSections
 *
 * [MOUNTED] --> renders each section card delegating to domain hooks.
 */

import type { useAccordion } from '../hooks/useAccordion';
import type { useIntegrationData } from '../hooks/useIntegrationData';
import type { useBrowserSync } from '../hooks/useBrowserSync';
import type { usePasswordSync } from '../hooks/usePasswordSync';
import type { usePasswordRequest } from '../hooks/usePasswordRequest';
import type { useComputeSync } from '../hooks/useComputeSync';
import type { useMessagesSync } from '../hooks/useMessagesSync';
import type { useGmailConnect } from '../hooks/useGmailConnect';
import type { useIntegrationActions } from '../hooks/useIntegrationActions';

import BrowserCookiesSection from './BrowserCookiesSection';
import PasswordsSection from './PasswordsSection';
import MessagesSyncSection from './MessagesSyncSection';
import ComputeSection from './ComputeSection';
import SocialsSection from './SocialsSection';

interface IntegrationSectionsProps {
  isBrowserCookiesAvailable: boolean;
  isIMessageAvailable: boolean;
  isClaudeCodeAvailable: boolean;
  isFullySignedIn: boolean;
  accordion: ReturnType<typeof useAccordion>;
  data: ReturnType<typeof useIntegrationData>;
  browser: ReturnType<typeof useBrowserSync>;
  passwords: ReturnType<typeof usePasswordSync>;
  passwordRequest: ReturnType<typeof usePasswordRequest>;
  compute: ReturnType<typeof useComputeSync>;
  messages: ReturnType<typeof useMessagesSync>;
  gmail: ReturnType<typeof useGmailConnect>;
  actions: ReturnType<typeof useIntegrationActions>;
}

export default function IntegrationSections({
  isBrowserCookiesAvailable,
  isIMessageAvailable,
  isClaudeCodeAvailable,
  isFullySignedIn,
  accordion,
  data,
  browser,
  passwords,
  passwordRequest,
  compute,
  messages,
  gmail,
  actions,
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
        chromePasswordsSynced={data.chromePasswordsSynced}
        applePasswordsSynced={data.applePasswordsSynced}
        atlasPasswordsSynced={data.atlasPasswordsSynced}
        passwordSyncLoading={passwords.passwordSyncLoading}
        onChromeSync={() => void actions.onChromePasswordsSync()}
        onApplePasswordsOpen={() => passwords.setApplePasswordsModalOpen(true)}
        onAtlasPasswordsOpen={() => passwords.setAtlasPasswordsModalOpen(true)}
        passwordRequestExpanded={passwordRequest.passwordRequestExpanded}
        onPasswordRequestExpand={() => passwordRequest.setPasswordRequestExpanded(true)}
        passwordRequestInput={passwordRequest.passwordRequestInput}
        onPasswordRequestInputChange={passwordRequest.setPasswordRequestInput}
        passwordRequestSending={passwordRequest.passwordRequestSending}
        passwordRequestSent={passwordRequest.passwordRequestSent}
        onPasswordRequestSubmit={() => void actions.onPasswordRequest()}
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
        <ComputeSection
          expanded={accordion.computeExpanded}
          onToggle={() => accordion.toggleSection('compute')}
          isClaudeCodeAvailable={isClaudeCodeAvailable}
          claudeCodeSynced={data.claudeCodeSynced}
          claudeCodeSyncLoading={compute.claudeCodeSyncLoading}
          claudeCodeStatus={compute.claudeCodeStatus}
          onClaudeCodeSync={() => void actions.onClaudeCodeSync()}
        />
      )}

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
