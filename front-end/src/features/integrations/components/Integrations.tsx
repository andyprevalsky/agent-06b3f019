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

import { Loader2 } from 'lucide-react';

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
import { useGranola } from '../hooks/useGranola';

import DesktopIntegrations from './DesktopIntegrations';
import IntegrationModals from './IntegrationModals';
import IntegrationSections from './IntegrationSections';
import FileInputs from './FileInputs';
import IPhoneConnectionSection from './IPhoneConnectionSection';

export default function Integrations() {
  const handlers = useIntegrationHandlers();
  const { isFullySignedIn, user } = useAuth();

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
  const actions = useIntegrationActions({
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

  const displayError = actions.error ?? oauth.oauthError;
  const displaySuccess = actions.success ?? oauth.oauthSuccess;

  return (
    <div className="h-full overflow-y-auto">
      <div className="container max-w-3xl mx-auto pt-20 pb-12 px-4">
        {displayError && (
          <div className="mb-6 p-4 bg-destructive/10 border border-destructive rounded-lg text-destructive text-sm">
            {displayError}
          </div>
        )}
        {displaySuccess && (
          <div className="mb-6 p-4 bg-green-500/10 border border-green-500 rounded-lg text-green-600 dark:text-green-400 text-sm">
            {displaySuccess}
          </div>
        )}

        <FileInputs
          fileUpload={fileUpload}
          onFileChange={(type, file) => void actions.onFileChange(type, file)}
        />

        <div className="space-y-3">
          <IPhoneConnectionSection key={user?.id ?? 'signed-out'} />
          {data.loadingIntegrations ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <IntegrationSectionsSwitch
              isBrowserCookiesAvailable={!!handlers.browserCookies?.isAvailable}
              isPasskeysAvailable={!!handlers.passkeys?.isAvailable}
              isIMessageAvailable={!!handlers.iMessage?.isAvailable}
              isWhatsAppAvailable={!!handlers.whatsApp?.isAvailable}
              isClaudeCodeAvailable={!!handlers.claudeCode?.isAvailable}
              isGptCodeAvailable={!!handlers.gptCode?.isAvailable}
              isFileSystemAvailable={window.api?.isElectron === true}
              isFullySignedIn={isFullySignedIn}
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
    </div>
  );
}

/** Stock cards with the flag off; the Rose Desktop list with it on. */
function IntegrationSectionsSwitch({
  accordion,
  ...rest
}: Omit<React.ComponentProps<typeof IntegrationSections>, 'granola'>) {
  const granola = useGranola(rest.isFullySignedIn, rest.data.fetchIntegrations);
  const props = { ...rest, granola };
  if (useRoseDesktop()) return <DesktopIntegrations {...props} />;
  return <IntegrationSections accordion={accordion} {...props} />;
}
