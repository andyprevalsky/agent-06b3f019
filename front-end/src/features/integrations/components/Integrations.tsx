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
 * [FILE_UPLOADING] [BROWSER_SYNC]  |  [CONNECTING]  [HANDLER/PASSWORD_UPLOADING]
 *       |           |              |       |               |
 *       v           v              v       v               v
 *       +----------(atlas modal?)--+-------+----(apple passwords modal?)
 *                              v
 *                         [IDLE/READY]
 *
 * This component is a thin orchestrator: it calls hooks, renders sections,
 * and wires up modals. All business logic lives in ../hooks/.
 */

import { Loader2 } from 'lucide-react';

import {
  useAccordion,
  useIntegrationData,
  useBrowserSync,
  usePasswordSync,
  usePasswordRequest,
  useComputeSync,
  useMessagesSync,
  useFileUpload,
  useGmailConnect,
  useOAuthRedirect,
  useIntegrationActions,
  useIntegrationHandlers,
  useAuth,
} from '../hooks';

import IntegrationModals from './IntegrationModals';
import IntegrationSections from './IntegrationSections';
import FileInputs from './FileInputs';

export default function Integrations() {
  const handlers = useIntegrationHandlers();
  const { isFullySignedIn } = useAuth();

  const accordion = useAccordion();
  const data = useIntegrationData();
  const browser = useBrowserSync(handlers, data.fetchIntegrations);
  const passwords = usePasswordSync(handlers, data.fetchIntegrations);
  const passwordRequest = usePasswordRequest();
  const compute = useComputeSync(handlers, data.fetchIntegrations);
  const messages = useMessagesSync(handlers, data.fetchIntegrations);
  const fileUpload = useFileUpload();
  const gmail = useGmailConnect(data.fetchIntegrations);
  const oauth = useOAuthRedirect(data.fetchIntegrations);
  const actions = useIntegrationActions({
    handleBrowserSync: browser.handleBrowserSync,
    handleChromePasswordsSync: passwords.handleChromePasswordsSync,
    handleApplePasswordsSync: passwords.handleApplePasswordsSync,
    handleAtlasPasswordsSync: passwords.handleAtlasPasswordsSync,
    handlePasswordRequest: passwordRequest.handlePasswordRequest,
    handleClaudeCodeSync: compute.handleClaudeCodeSync,
    handleIMessageSync: messages.handleIMessageSync,
    handleLinkedInSync: messages.handleLinkedInSync,
    handleEmailConnect: gmail.handleEmailConnect,
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
          {data.loadingIntegrations ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <IntegrationSections
              isBrowserCookiesAvailable={!!handlers.browserCookies?.isAvailable}
              isIMessageAvailable={!!handlers.iMessage?.isAvailable}
              isClaudeCodeAvailable={!!handlers.claudeCode?.isAvailable}
              isFullySignedIn={isFullySignedIn}
              accordion={accordion}
              data={data}
              browser={browser}
              passwords={passwords}
              passwordRequest={passwordRequest}
              compute={compute}
              messages={messages}
              gmail={gmail}
              actions={actions}
            />
          )}
        </div>
      </div>

      <IntegrationModals browser={browser} passwords={passwords} actions={actions} />
    </div>
  );
}
