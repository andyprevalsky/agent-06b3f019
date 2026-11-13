/**
 * STATE MACHINE: Integrations
 *
 *                              [LOADING]
 *                                  |
 *                                  v (fetchIntegrations + getInstalledBrowsers)
 *       +-------------------[IDLE/READY]-------------------+
 *       |           |              |    |                  |
 *       | (file)    | (browser)    |    |  (provider)      | (handler/passwords)
 *       v           v              |    v                  v
 * [FILE_UPLOADING] [BROWSER_SYNC]  |  [CONNECTING]  [HANDLER/CREDENTIAL_EXCHANGE]
 *       |           |              |       |               |
 *       v           v              v       v               v
 *       +----------(atlas modal?)--+-------+----(Apple Passwords & Passkeys modal)
 *                              v
 *                         [IDLE/READY]
 *
 * [READY] --search tokens--> [MATCHING GROUPS | EMPTY] --clear--> [READY]
 * Hidden groups stay mounted, preserving connection state and actions.
 *
 * Pebble Index 01 (last row/card) --Connect--> PebbleIndexSetupModal (guided
 * webhook setup; state owned here, in both presentations).
 *
 * Team sharing uses explicit per-account, per-team opt-ins, saved independently.
 *
 * File System is a FE-only section: website is Download for Mac; Mac app
 * plus click stays [IDLE/READY] (no hook).
 *
 * Rose Desktop flag (useRoseDesktop):
 *   off → IntegrationSections (stock accordion cards, unchanged)
 *   on  → DesktopIntegrations (flat sections, account chips, sync progress bars)
 *   Both receive the SAME hook state; only presentation differs.
 *
 * This component is a thin orchestrator: it calls hooks, renders sections,
 * and wires up modals. All business logic lives in ../hooks/.
 */

import { useState } from 'react';
import { hasIntegrationSearchResults, integrationMatchesSearch } from '../hooks/integrationSearch';
import IntegrationSearch from './IntegrationSearch';
import { Loader2 } from 'lucide-react';

import { IntegrationTeamSharing } from '@/components/teams/TeamSharing';
import { useRoseDesktop } from '@/hooks/roseDesktopContext';

import {
  useAccordion,
  useIntegrationData,
  useBrowserSync,
  usePasswordSync,
  useComputeSync,
  useMessagesSync,
  useFileUpload,
  useGmailConnect,
  useOAuthRedirect,
  useIntegrationActions,
  useIntegrationHandlers,
  useAuth,
} from '../hooks';
import { usePlaidIntegration } from '../hooks/usePlaidIntegration';
import { useGithubRepos } from '../hooks/useGithubRepos';
import { useMeetingNotes } from '../hooks/useMeetingNotes';

import DesktopIntegrations from './DesktopIntegrations';
import IntegrationModals from './IntegrationModals';
import IntegrationSections from './IntegrationSections';
import FileInputs from './FileInputs';
import PebbleIndexSetupModal from './PebbleIndexSetupModal';
import IPhoneConnectionSection from './IPhoneConnectionSection';

function IntegrationBanners({
  error,
  success,
}: {
  error: string | null | undefined;
  success: string | null | undefined;
}) {
  return (
    <>
      {error && (
        <div className="mb-6 p-4 bg-destructive/10 border border-destructive rounded-lg text-destructive text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-6 p-4 bg-green-500/10 border border-green-500 rounded-lg text-green-600 dark:text-green-400 text-sm">
          {success}
        </div>
      )}
    </>
  );
}

/** STATE MACHINE: [NO MATCHES] --clear--> full catalog. */
function IntegrationSearchEmpty({ onClear }: { onClear: () => void }) {
  return (
    <div
      role="status"
      className="rounded-xl border border-dashed border-border px-6 py-10 text-center"
    >
      <p className="font-medium">No integrations found</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Try an app name, domain, or capability like meeting notes.
      </p>
      <button type="button" onClick={onClear} className="mt-3 text-sm underline underline-offset-4">
        Clear search
      </button>
    </div>
  );
}

function usePageActions({
  browser,
  passwords,
  compute,
  messages,
  gmail,
  fileUpload,
}: {
  browser: ReturnType<typeof useBrowserSync>;
  passwords: ReturnType<typeof usePasswordSync>;
  compute: ReturnType<typeof useComputeSync>;
  messages: ReturnType<typeof useMessagesSync>;
  gmail: ReturnType<typeof useGmailConnect>;
  fileUpload: ReturnType<typeof useFileUpload>;
}) {
  return useIntegrationActions({
    handleBrowserSync: browser.handleBrowserSync,
    handleChromePasswordsSync: passwords.handleChromePasswordsSync,
    handleAtlasPasswordsSync: passwords.handleAtlasPasswordsSync,
    handlePasskeysConnect: passwords.handlePasskeysConnect,
    handleClaudeCodeSync: compute.handleClaudeCodeSync,
    handleGptCodeSync: compute.handleGptCodeSync,
    handleIMessageSync: messages.handleIMessageSync,
    handleWhatsAppConnect: messages.handleWhatsAppConnect,
    handleLinkedInSync: messages.handleLinkedInSync,
    handleEmailConnect: gmail.handleEmailConnect,
    handleEmailDisconnect: gmail.handleEmailDisconnect,
    handleEmailResync: gmail.handleEmailResync,
    handleFileUpload: fileUpload.handleFileUpload,
  });
}

export default function Integrations({ initialSearch = '' }: { initialSearch?: string } = {}) {
  const handlers = useIntegrationHandlers();
  const { isFullySignedIn, user, loading: authLoading } = useAuth();

  const accordion = useAccordion();
  const data = useIntegrationData();
  const browser = useBrowserSync(handlers, data.fetchIntegrations);
  const passwords = usePasswordSync(handlers, data.fetchIntegrations);
  const compute = useComputeSync(handlers, data.fetchIntegrations);
  const messages = useMessagesSync(handlers, data.fetchIntegrations, data.linkedinStatus);
  const fileUpload = useFileUpload();
  const gmail = useGmailConnect(data.fetchIntegrations);
  const plaid = usePlaidIntegration();
  const oauth = useOAuthRedirect(data.fetchIntegrations);
  const [search, setSearch] = useState(initialSearch);
  const [pebbleSetupOpen, setPebbleSetupOpen] = useState(false);
  const actions = usePageActions({ browser, passwords, compute, messages, gmail, fileUpload });

  return (
    <div className="h-full overflow-y-auto">
      <div className="container max-w-3xl mx-auto pt-20 pb-12 px-4">
        <IntegrationSearch value={search} onChange={setSearch} />
        <IntegrationBanners
          error={actions.error ?? oauth.oauthError}
          success={actions.success ?? oauth.oauthSuccess}
        />

        <FileInputs
          fileUpload={fileUpload}
          onFileChange={(type, file) => void actions.onFileChange(type, file)}
        />

        <div className="space-y-3">
          <IntegrationTeamSharing />
          <div hidden={!integrationMatchesSearch('iphone', search)}>
            <IPhoneConnectionSection key={user?.id ?? 'signed-out'} />
          </div>
          {!data.loadingIntegrations &&
            !authLoading &&
            !hasIntegrationSearchResults(search, isFullySignedIn) && (
              <IntegrationSearchEmpty onClear={() => setSearch('')} />
            )}
          {data.loadingIntegrations ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <IntegrationSectionsSwitch
              search={search}
              isBrowserCookiesAvailable={!!handlers.browserCookies?.isAvailable}
              isPasskeysAvailable={!!handlers.passkeys?.isAvailable}
              isIMessageAvailable={!!handlers.iMessage?.isAvailable}
              isWhatsAppAvailable={!!handlers.whatsApp?.isAvailable}
              isClaudeCodeAvailable={!!handlers.claudeCode?.isAvailable}
              isGptCodeAvailable={!!handlers.gptCode?.isAvailable}
              isFileSystemAvailable={window.api?.isElectron === true}
              isFullySignedIn={isFullySignedIn}
              onPebbleIndexConnect={() => setPebbleSetupOpen(true)}
              accordion={accordion}
              data={data}
              browser={browser}
              passwords={passwords}
              compute={compute}
              messages={messages}
              gmail={gmail}
              actions={actions}
              plaid={plaid}
            />
          )}
        </div>
      </div>

      <IntegrationModals browser={browser} passwords={passwords} actions={actions} />
      <PebbleIndexSetupModal open={pebbleSetupOpen} onClose={() => setPebbleSetupOpen(false)} />
    </div>
  );
}

/** Stock cards with the flag off; the Rose Desktop list with it on. */
function IntegrationSectionsSwitch({
  accordion,
  ...rest
}: Omit<React.ComponentProps<typeof IntegrationSections>, 'meetingNotes' | 'github'>) {
  const granola = useMeetingNotes('granola', rest.isFullySignedIn, rest.data.fetchIntegrations);
  const fireflies = useMeetingNotes('fireflies', rest.isFullySignedIn, rest.data.fetchIntegrations);
  const github = useGithubRepos(rest.isFullySignedIn);
  const props = { ...rest, meetingNotes: { granola, fireflies }, github };
  if (useRoseDesktop()) return <DesktopIntegrations {...props} />;
  return <IntegrationSections accordion={accordion} {...props} />;
}
