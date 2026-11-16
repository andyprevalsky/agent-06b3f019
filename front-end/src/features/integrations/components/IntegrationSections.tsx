/**
 * STATE MACHINE: IntegrationSections
 *
 * [MOUNTED] --> renders each section card delegating to domain hooks.
 *
 * Meeting note taker: shared Granola/Fireflies provider cards and hooks.
 * Signed in, after File System: GitHub Repositories (ProjectsSection: projects =
 * repos, import from your computer, connect a GitHub repo); then, sharing
 * integrationCardStyles, CLIs (verified via a setup agent) and MCP servers (URL +
 * optional API key header or OAuth via /integrations/mcp/callback; reconnect, remove).
 * Pebble Index 01 (last) opens the guided setup modal owned by Integrations.
 *
 * File System is a FE-only stub: website shows Download for Mac; Mac app
 * shows the plus and stays [MOUNTED] on click (no hook, no backend).
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
import MeetingNotesSection from './MeetingNotesSection';
import SearchGroup from './IntegrationSearchGroup';
import ProjectsSection, { type ProjectsSectionProps } from './ProjectsSection';
import type { MeetingNotesConnections } from '../types';

import BrowserCookiesSection from './BrowserCookiesSection';
import PasswordsSection from './PasswordsSection';
import MessagesSyncSection from './MessagesSyncSection';
import ComputeSection from './ComputeSection';
import SocialsSection from './SocialsSection';
import PlaidSection from './PlaidSection';
import FileSystemSection from './FileSystemSection';
import ToolIntegrationSections from './ToolIntegrationSections';
import PebbleIndexSection from './PebbleIndexSection';

interface IntegrationSectionsProps {
  search: string;
  isBrowserCookiesAvailable: boolean;
  isPasskeysAvailable: boolean;
  isIMessageAvailable: boolean;
  isWhatsAppAvailable: boolean;
  isClaudeCodeAvailable: boolean;
  isGptCodeAvailable: boolean;
  isFileSystemAvailable: boolean;
  isFullySignedIn: boolean;
  onPebbleIndexConnect: () => void;
  accordion: ReturnType<typeof useAccordion>;
  data: ReturnType<typeof useIntegrationData>;
  browser: ReturnType<typeof useBrowserSync>;
  passwords: ReturnType<typeof usePasswordSync>;
  compute: ReturnType<typeof useComputeSync>;
  messages: ReturnType<typeof useMessagesSync>;
  gmail: ReturnType<typeof useGmailConnect>;
  actions: ReturnType<typeof useIntegrationActions>;
  plaid: ReturnType<typeof usePlaidIntegration>;
  meetingNotes: MeetingNotesConnections;
  projectSettings?: ProjectsSectionProps['projectSettings'];
}

function PlaidIntegrationSection({ plaid }: Pick<IntegrationSectionsProps, 'plaid'>) {
  return (
    <PlaidSection
      items={plaid.items}
      itemsLoading={plaid.itemsLoading}
      connectLoading={plaid.connectLoading}
      disconnectingItemId={plaid.disconnectingItemId}
      error={plaid.error}
      onConnect={plaid.onConnect}
      onUpdate={plaid.onUpdate}
      onDisconnect={plaid.onDisconnect}
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

function MessagesIntegrationSection({
  isIMessageAvailable,
  isWhatsAppAvailable,
  accordion,
  data,
  messages,
  gmail,
  actions,
}: Pick<
  IntegrationSectionsProps,
  | 'isIMessageAvailable'
  | 'isWhatsAppAvailable'
  | 'accordion'
  | 'data'
  | 'messages'
  | 'gmail'
  | 'actions'
>) {
  return (
    <MessagesSyncSection
      expanded={accordion.messagesSyncExpanded}
      onToggle={() => accordion.toggleSection('messagesSync')}
      isIMessageAvailable={isIMessageAvailable}
      isWhatsAppAvailable={isWhatsAppAvailable}
      iMessageSynced={data.iMessageSynced}
      whatsAppConnected={data.whatsAppConnected}
      messageSyncLoading={messages.messageSyncLoading}
      onIMessageSync={() => void actions.onIMessageSync()}
      onWhatsAppConnect={() => void actions.onWhatsAppConnect()}
      connectedIntegrations={data.connectedIntegrations}
      connectingProvider={gmail.connectingProvider}
      disconnectingEmail={gmail.disconnectingEmail}
      resyncingEmail={gmail.resyncingEmail}
      onGmailConnect={() => void actions.onGmailConnect()}
      onGmailDisconnect={(email) => void actions.onGmailDisconnect(email)}
      onGmailResync={(email) => void actions.onGmailResync(email)}
    />
  );
}

function PasswordsIntegrationSection({
  isBrowserCookiesAvailable,
  isPasskeysAvailable,
  accordion,
  data,
  passwords,
  actions,
}: Pick<
  IntegrationSectionsProps,
  | 'isBrowserCookiesAvailable'
  | 'isPasskeysAvailable'
  | 'accordion'
  | 'data'
  | 'passwords'
  | 'actions'
>) {
  return (
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
  );
}

function SocialsIntegrationSection({
  isBrowserCookiesAvailable,
  accordion,
  messages,
  actions,
}: Pick<
  IntegrationSectionsProps,
  'isBrowserCookiesAvailable' | 'accordion' | 'messages' | 'actions'
>) {
  return (
    <SocialsSection
      expanded={accordion.socialsExpanded}
      onToggle={() => accordion.toggleSection('socials')}
      isBrowserCookiesAvailable={isBrowserCookiesAvailable}
      linkedinSyncLoading={messages.linkedinSyncLoading}
      linkedinSyncStarted={messages.linkedinSyncStarted}
      linkedinConnected={messages.linkedinConnected}
      onLinkedInSync={() => void actions.onLinkedInSync()}
    />
  );
}

export default function IntegrationSections(props: IntegrationSectionsProps) {
  const {
    search,
    isBrowserCookiesAvailable,
    isPasskeysAvailable,
    isIMessageAvailable,
    isWhatsAppAvailable,
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
  } = props;
  return (
    <>
      <SearchGroup catalogKey="browsers" search={search}>
        <BrowserCookiesSection
          isAvailable={isBrowserCookiesAvailable}
          expanded={accordion.browsersExpanded}
          onToggle={() => accordion.toggleSection('browsers')}
          installedBrowsers={browser.installedBrowsers}
          connectedBrowsers={data.connectedBrowsers}
          browserSyncLoading={browser.browserSyncLoading}
          onBrowserSync={(bt) => void actions.onBrowserSync(bt)}
        />
      </SearchGroup>

      <SearchGroup catalogKey="passwords" search={search}>
        <PasswordsIntegrationSection
          isBrowserCookiesAvailable={isBrowserCookiesAvailable}
          isPasskeysAvailable={isPasskeysAvailable}
          accordion={accordion}
          data={data}
          passwords={passwords}
          actions={actions}
        />
      </SearchGroup>

      <SearchGroup catalogKey="messages" search={search}>
        <MessagesIntegrationSection
          isIMessageAvailable={isIMessageAvailable}
          isWhatsAppAvailable={isWhatsAppAvailable}
          accordion={accordion}
          data={data}
          messages={messages}
          gmail={gmail}
          actions={actions}
        />
      </SearchGroup>

      {isFullySignedIn && (
        <SearchGroup catalogKey="compute" search={search}>
          <ComputeIntegrationSection
            isClaudeCodeAvailable={isClaudeCodeAvailable}
            isGptCodeAvailable={isGptCodeAvailable}
            accordion={accordion}
            data={data}
            compute={compute}
            actions={actions}
          />
        </SearchGroup>
      )}

      {isFullySignedIn && (
        <SearchGroup catalogKey="banks" search={search}>
          <PlaidIntegrationSection plaid={plaid} />
        </SearchGroup>
      )}

      <SecondaryIntegrationSections {...props} />
    </>
  );
}

/** STATE MACHINE: secondary groups preserve state while search toggles visibility. */
function SecondaryIntegrationSections({
  search,
  isBrowserCookiesAvailable,
  isFileSystemAvailable,
  isFullySignedIn,
  onPebbleIndexConnect,
  accordion,
  messages,
  actions,
  meetingNotes,
  projectSettings,
}: IntegrationSectionsProps) {
  return (
    <>
      <SearchGroup catalogKey="socials" search={search}>
        <SocialsIntegrationSection
          isBrowserCookiesAvailable={isBrowserCookiesAvailable}
          accordion={accordion}
          messages={messages}
          actions={actions}
        />
      </SearchGroup>

      <SearchGroup catalogKey="files" search={search}>
        <FileSystemSection isAvailable={isFileSystemAvailable} />
      </SearchGroup>

      {isFullySignedIn && (
        <SearchGroup catalogKey="projects" search={search}>
          <ProjectsSection projectSettings={projectSettings} />
        </SearchGroup>
      )}
      {isFullySignedIn && <ToolIntegrationSections search={search} />}
      {isFullySignedIn && (
        <SearchGroup catalogKey="meetingNotes" search={search}>
          <MeetingNotesSection connections={meetingNotes} />
        </SearchGroup>
      )}
      <SearchGroup catalogKey="pebble" search={search}>
        <PebbleIndexSection onConnect={onPebbleIndexConnect} />
      </SearchGroup>
    </>
  );
}
