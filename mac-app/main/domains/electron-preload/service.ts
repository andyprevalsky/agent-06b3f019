/**
 * Service layer for the electron-preload domain.
 *
 * Pure factory: given an `IpcRenderer` instance, produce the `IPC` bridge
 * object the renderer will see as `window.api`. No side effects —
 * `contextBridge.exposeInMainWorld` is invoked by `runtime.ts`.
 *
 * Each method is a thin wrapper over `ipcRenderer.invoke` (request/response).
 * Subscription-channel builders live in `service-events.ts`. Channel names
 * and argument order are the wire contract with main-process handlers; do
 * NOT alter them without updating the handlers in lockstep.
 */

import type { IpcRenderer } from 'electron';
import type {
  IPC,
  AuthSession,
  UploadResult,
  CookieData,
  FingerprintData,
  QuickQueryPayload,
  DirectIMessagePayload,
  ShortcutConfig,
  BrowserType,
  BrowserInfo,
  ReadBrowserCookiesConfig,
  PasskeyEnrollParams,
  AutoFillSettingsResult,
} from '../../../shared/types/ipc';
import {
  buildEventBridge,
  buildTelegramEventBridge,
  buildUnsubscribableEventBridge,
} from './service-events';

function buildAuthBridge(ipcRenderer: IpcRenderer): IPC['auth'] {
  return {
    check: () => ipcRenderer.invoke('auth:check') as Promise<AuthSession | null>,
    save: (session: AuthSession) =>
      ipcRenderer.invoke('auth:save', session) as Promise<{ success: boolean }>,
    clear: () => ipcRenderer.invoke('auth:clear') as Promise<{ success: boolean }>,
  };
}

function buildShortcutBridge(ipcRenderer: IpcRenderer): IPC['shortcut'] {
  return {
    get: () => ipcRenderer.invoke('shortcut:get') as Promise<ShortcutConfig | null>,
    set: (config: ShortcutConfig) =>
      ipcRenderer.invoke('shortcut:set', config) as Promise<{ success: boolean }>,
    validate: (config: ShortcutConfig) =>
      ipcRenderer.invoke('shortcut:validate', config) as Promise<{ available: boolean }>,
    enable: () =>
      ipcRenderer.invoke('shortcut:enable') as Promise<{ success: boolean; enabled: boolean }>,
    disable: () =>
      ipcRenderer.invoke('shortcut:disable') as Promise<{ success: boolean; enabled: boolean }>,
    isEnabled: () => ipcRenderer.invoke('shortcut:isEnabled') as Promise<{ enabled: boolean }>,
  };
}

function buildOnboardingBridge(ipcRenderer: IpcRenderer): IPC['onboarding'] {
  return {
    isComplete: () => ipcRenderer.invoke('onboarding:isComplete') as Promise<boolean>,
    setComplete: (complete: boolean) =>
      ipcRenderer.invoke('onboarding:setComplete', complete) as Promise<{ success: boolean }>,
    getLastAuthProvider: () =>
      ipcRenderer.invoke('onboarding:getLastAuthProvider') as Promise<string | null>,
    setLastAuthProvider: (provider: string) =>
      ipcRenderer.invoke('onboarding:setLastAuthProvider', provider) as Promise<{
        success: boolean;
      }>,
  };
}

function buildClaudeCodeBridge(ipcRenderer: IpcRenderer): IPC['claudeCode'] {
  return {
    hasCredentials: () => ipcRenderer.invoke('claude:hasCredentials') as Promise<boolean>,
    syncCredentials: () =>
      ipcRenderer.invoke('claude:syncCredentials') as Promise<{
        success: boolean;
        message?: string;
      }>,
    setMockNoClaudeCode: (mock: boolean) =>
      ipcRenderer.invoke('claude:setMockNoClaudeCode', mock) as Promise<{ success: boolean }>,
  };
}

function buildGptCodeBridge(ipcRenderer: IpcRenderer): IPC['gptCode'] {
  return {
    hasCredentials: () => ipcRenderer.invoke('gpt:hasCredentials') as Promise<boolean>,
    syncCredentials: () =>
      ipcRenderer.invoke('gpt:syncCredentials') as Promise<{
        success: boolean;
        message?: string;
      }>,
  };
}

function buildAtlasBridge(ipcRenderer: IpcRenderer): IPC['atlas'] {
  return {
    storePassword: (password: string) =>
      ipcRenderer.invoke('atlas:storePassword', password) as Promise<{
        success: boolean;
        error?: string;
      }>,
    hasPassword: () => ipcRenderer.invoke('atlas:hasPassword') as Promise<boolean>,
    clearPassword: () => ipcRenderer.invoke('atlas:clearPassword') as Promise<{ success: boolean }>,
  };
}

function buildPasskeysBridge(ipcRenderer: IpcRenderer): IPC['passkeys'] {
  return {
    enroll: (params: PasskeyEnrollParams) => ipcRenderer.invoke('passkeys:enroll', params),
  };
}

function buildWhatsAppBridge(ipcRenderer: IpcRenderer): IPC['whatsapp'] {
  return {
    hasCredentials: () => ipcRenderer.invoke('whatsapp:hasCredentials') as Promise<boolean>,
    getLinkedPhoneNumber: () =>
      ipcRenderer.invoke('whatsapp:getLinkedPhoneNumber') as Promise<string | null>,
    isConnected: (accountId?: string) =>
      ipcRenderer.invoke('whatsapp:isConnected', accountId) as Promise<boolean>,
    listAccounts: () =>
      ipcRenderer.invoke('whatsapp:listAccounts') as Promise<
        Array<{ accountId: string; connected: boolean }>
      >,
    connect: () =>
      ipcRenderer.invoke('whatsapp:connect') as Promise<{ success: boolean; error?: string }>,
    addAccount: () =>
      ipcRenderer.invoke('whatsapp:addAccount') as Promise<{ success: boolean; error?: string }>,
    disconnect: () =>
      ipcRenderer.invoke('whatsapp:disconnect') as Promise<{ success: boolean; error?: string }>,
    logout: (accountId?: string) =>
      ipcRenderer.invoke('whatsapp:logout', accountId) as Promise<{
        success: boolean;
        error?: string;
      }>,
  };
}

function buildTelegramBridge(ipcRenderer: IpcRenderer): IPC['telegram'] {
  return {
    hasSession: () => ipcRenderer.invoke('telegram:hasSession') as Promise<boolean>,
    hasApiCredentials: () => ipcRenderer.invoke('telegram:hasApiCredentials') as Promise<boolean>,
    isConnected: () => ipcRenderer.invoke('telegram:isConnected') as Promise<boolean>,
    connectWithExistingSession: () =>
      ipcRenderer.invoke('telegram:connectWithExistingSession') as Promise<{
        success: boolean;
        error?: string;
      }>,
    disconnect: () =>
      ipcRenderer.invoke('telegram:disconnect') as Promise<{ success: boolean; error?: string }>,
    logout: () =>
      ipcRenderer.invoke('telegram:logout') as Promise<{ success: boolean; error?: string }>,
    syncHistorical: (messagesPerDialog?: number) =>
      ipcRenderer.invoke('telegram:syncHistorical', messagesPerDialog) as Promise<{
        success: boolean;
        count?: number;
        error?: string;
      }>,
    startAuth: (phoneNumber: string) =>
      ipcRenderer.invoke('telegram:startAuth', phoneNumber) as Promise<{
        success: boolean;
        error?: string;
      }>,
    submitCode: (code: string) =>
      ipcRenderer.invoke('telegram:submitCode', code) as Promise<{
        success: boolean;
        error?: string;
      }>,
    submitPassword: (password: string) =>
      ipcRenderer.invoke('telegram:submitPassword', password) as Promise<{
        success: boolean;
        error?: string;
      }>,
    cancelAuth: () =>
      ipcRenderer.invoke('telegram:cancelAuth') as Promise<{ success: boolean; error?: string }>,
  };
}

function buildMessagingBridge(
  ipcRenderer: IpcRenderer
): Pick<
  IPC,
  | 'checkIMessageAccess'
  | 'startIMessageUpload'
  | 'sendIMessage'
  | 'readChromeCookies'
  | 'uploadCookies'
  | 'getInstalledBrowsers'
  | 'readBrowserCookies'
  | 'uploadBrowserCookies'
  | 'syncBrowser'
  | 'syncBrowserPasswords'
  | 'collectFingerprint'
  | 'uploadFingerprint'
> {
  return {
    checkIMessageAccess: () => ipcRenderer.invoke('imessage:checkAccess') as Promise<boolean>,
    startIMessageUpload: () => ipcRenderer.invoke('imessage:startUpload') as Promise<UploadResult>,
    sendIMessage: (payload: DirectIMessagePayload) =>
      ipcRenderer.invoke('imessage:sendDirect', payload) as Promise<{
        success: boolean;
        message?: string;
      }>,
    readChromeCookies: () => ipcRenderer.invoke('cookies:readChrome') as Promise<CookieData[]>,
    uploadCookies: (data: CookieData[]) =>
      ipcRenderer.invoke('cookies:upload', data) as Promise<UploadResult>,
    getInstalledBrowsers: () =>
      ipcRenderer.invoke('cookies:getInstalledBrowsers') as Promise<BrowserInfo[]>,
    readBrowserCookies: (browser: BrowserType, config?: ReadBrowserCookiesConfig) =>
      ipcRenderer.invoke('cookies:readBrowser', browser, config) as Promise<CookieData[]>,
    uploadBrowserCookies: (browser: BrowserType, data: CookieData[]) =>
      ipcRenderer.invoke('cookies:uploadBrowser', browser, data) as Promise<UploadResult>,
    syncBrowser: (browser: BrowserType, config?: ReadBrowserCookiesConfig) =>
      ipcRenderer.invoke('browser:sync', browser, config) as Promise<UploadResult>,
    syncBrowserPasswords: (browser: BrowserType, config?: { keychainPassword?: string }) =>
      ipcRenderer.invoke('browser:syncPasswords', browser, config) as Promise<UploadResult>,
    collectFingerprint: () =>
      ipcRenderer.invoke('fingerprint:collect') as Promise<FingerprintData | null>,
    uploadFingerprint: (data: FingerprintData) =>
      ipcRenderer.invoke('fingerprint:upload', data) as Promise<UploadResult>,
  };
}

function buildSystemAndUpdateBridge(
  ipcRenderer: IpcRenderer
): Pick<
  IPC,
  | 'openFullDiskAccessSettings'
  | 'openKeychainAccess'
  | 'openPasswordsApp'
  | 'openAutoFillSettings'
  | 'checkAutoFillSettings'
  | 'submitQuickQuery'
  | 'hideQuickQuery'
  | 'resizeQuickQuery'
  | 'setQuickQueryFileDrag'
  | 'checkForUpdates'
  | 'downloadUpdate'
  | 'restartToUpdate'
  | 'openExternal'
  | 'removePaymentCompleteListener'
> {
  return {
    openFullDiskAccessSettings: () =>
      ipcRenderer.invoke('system:openFullDiskAccess') as Promise<{ success: boolean }>,
    openKeychainAccess: (searchQuery?: string) =>
      ipcRenderer.invoke('system:openKeychainAccess', searchQuery) as Promise<{ success: boolean }>,
    openPasswordsApp: () =>
      ipcRenderer.invoke('system:openPasswordsApp') as Promise<{ success: boolean }>,
    openAutoFillSettings: () =>
      ipcRenderer.invoke('system:openAutoFillSettings') as Promise<AutoFillSettingsResult>,
    checkAutoFillSettings: () =>
      ipcRenderer.invoke('system:checkAutoFillSettings') as Promise<AutoFillSettingsResult>,
    submitQuickQuery: (payload: string | QuickQueryPayload) =>
      ipcRenderer.invoke('quick-query:submit', payload) as Promise<{ success: boolean }>,
    hideQuickQuery: () => ipcRenderer.invoke('quick-query:hide') as Promise<{ success: boolean }>,
    resizeQuickQuery: (payload) =>
      ipcRenderer.invoke('quick-query:resize', payload) as Promise<{ success: boolean }>,
    setQuickQueryFileDrag: (payload) =>
      ipcRenderer.invoke('quick-query:file-drag', payload) as Promise<{ success: boolean }>,
    checkForUpdates: () => ipcRenderer.invoke('updates:check') as Promise<{ success: boolean }>,
    downloadUpdate: () => ipcRenderer.invoke('updates:download') as Promise<{ success: boolean }>,
    restartToUpdate: () => ipcRenderer.invoke('updates:install') as Promise<{ success: boolean }>,
    openExternal: (url: string) =>
      ipcRenderer.invoke('shell:openExternal', url) as Promise<{ success: boolean }>,
    removePaymentCompleteListener: () => {
      ipcRenderer.removeAllListeners('payment-complete');
    },
  };
}

/**
 * Build the `IPC` bridge object that will be exposed on `window.api`.
 *
 * Pure — does not touch `contextBridge`. Tests can call this with a mock
 * `IpcRenderer` to assert channel routing without installing a bridge.
 */
export function buildIpcApi(ipcRenderer: IpcRenderer): IPC {
  return {
    isElectron: true,
    auth: buildAuthBridge(ipcRenderer),
    shortcut: buildShortcutBridge(ipcRenderer),
    onboarding: buildOnboardingBridge(ipcRenderer),
    claudeCode: buildClaudeCodeBridge(ipcRenderer),
    gptCode: buildGptCodeBridge(ipcRenderer),
    atlas: buildAtlasBridge(ipcRenderer),
    passkeys: buildPasskeysBridge(ipcRenderer),
    whatsapp: buildWhatsAppBridge(ipcRenderer),
    telegram: buildTelegramBridge(ipcRenderer),
    ...buildMessagingBridge(ipcRenderer),
    ...buildSystemAndUpdateBridge(ipcRenderer),
    ...buildEventBridge(ipcRenderer),
    ...buildUnsubscribableEventBridge(ipcRenderer),
    ...buildTelegramEventBridge(ipcRenderer),
  };
}
