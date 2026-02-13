import { contextBridge, ipcRenderer } from 'electron';
import type {
  IPC,
  AuthSession,
  UploadResult,
  CookieData,
  FingerprintData,
  UploadProgress,
  QuickQueryToggleState,
  QuickQueryPayload,
  DirectIMessagePayload,
  UpdateStatusPayload,
  ShortcutConfig,
  BrowserType,
  BrowserInfo,
  ReadBrowserCookiesConfig,
} from '../shared/types/ipc';

// Expose type-safe API to renderer
const api: IPC = {
  // Auth
  auth: {
    check: () => ipcRenderer.invoke('auth:check') as Promise<AuthSession | null>,
    save: (session: AuthSession) => ipcRenderer.invoke('auth:save', session) as Promise<{ success: boolean }>,
    clear: () => ipcRenderer.invoke('auth:clear') as Promise<{ success: boolean }>,
  },

  // Shortcut configuration
  shortcut: {
    get: () => ipcRenderer.invoke('shortcut:get') as Promise<ShortcutConfig | null>,
    set: (config: ShortcutConfig) => ipcRenderer.invoke('shortcut:set', config) as Promise<{ success: boolean }>,
    validate: (config: ShortcutConfig) => ipcRenderer.invoke('shortcut:validate', config) as Promise<{ available: boolean }>,
    enable: () => ipcRenderer.invoke('shortcut:enable') as Promise<{ success: boolean; enabled: boolean }>,
    disable: () => ipcRenderer.invoke('shortcut:disable') as Promise<{ success: boolean; enabled: boolean }>,
    isEnabled: () => ipcRenderer.invoke('shortcut:isEnabled') as Promise<{ enabled: boolean }>,
  },

  // Onboarding state
  onboarding: {
    isComplete: () => ipcRenderer.invoke('onboarding:isComplete') as Promise<boolean>,
    setComplete: (complete: boolean) => ipcRenderer.invoke('onboarding:setComplete', complete) as Promise<{ success: boolean }>,
    getLastAuthProvider: () => ipcRenderer.invoke('onboarding:getLastAuthProvider') as Promise<string | null>,
    setLastAuthProvider: (provider: string) => ipcRenderer.invoke('onboarding:setLastAuthProvider', provider) as Promise<{ success: boolean }>,
  },

  // iMessage
  checkIMessageAccess: () => ipcRenderer.invoke('imessage:checkAccess') as Promise<boolean>,
  startIMessageUpload: () => ipcRenderer.invoke('imessage:startUpload') as Promise<UploadResult>,
  sendIMessage: (payload: DirectIMessagePayload) =>
    ipcRenderer.invoke('imessage:sendDirect', payload) as Promise<{ success: boolean; message?: string }>,
  
  // Cookies (legacy Chrome-only)
  readChromeCookies: () => ipcRenderer.invoke('cookies:readChrome') as Promise<CookieData[]>,
  uploadCookies: (data: CookieData[]) =>
    ipcRenderer.invoke('cookies:upload', data) as Promise<UploadResult>,

  // Browser cookies (multi-browser support)
  getInstalledBrowsers: () => ipcRenderer.invoke('cookies:getInstalledBrowsers') as Promise<BrowserInfo[]>,
  readBrowserCookies: (browser: BrowserType, config?: ReadBrowserCookiesConfig) =>
    ipcRenderer.invoke('cookies:readBrowser', browser, config) as Promise<CookieData[]>,
  uploadBrowserCookies: (browser: BrowserType, data: CookieData[]) =>
    ipcRenderer.invoke('cookies:uploadBrowser', browser, data) as Promise<UploadResult>,

  // Full browser sync (cookies + localStorage + IndexedDB + permissions + Cache Storage in parallel)
  syncBrowser: (browser: BrowserType, config?: ReadBrowserCookiesConfig) =>
    ipcRenderer.invoke('browser:sync', browser, config) as Promise<UploadResult>,

  // Password-only sync (just reads and uploads passwords, not full browser state)
  // For Atlas, pass keychainPassword in config
  syncBrowserPasswords: (browser: BrowserType, config?: { keychainPassword?: string }) =>
    ipcRenderer.invoke('browser:syncPasswords', browser, config) as Promise<UploadResult>,

  // Fingerprint
  collectFingerprint: () => ipcRenderer.invoke('fingerprint:collect') as Promise<FingerprintData | null>,
  uploadFingerprint: (data: FingerprintData) =>
    ipcRenderer.invoke('fingerprint:upload', data) as Promise<UploadResult>,

  // System
  openFullDiskAccessSettings: () => ipcRenderer.invoke('system:openFullDiskAccess') as Promise<{ success: boolean }>,
  openKeychainAccess: (searchQuery?: string) =>
    ipcRenderer.invoke('system:openKeychainAccess', searchQuery) as Promise<{ success: boolean }>,
  openPasswordsApp: () => ipcRenderer.invoke('system:openPasswordsApp') as Promise<{ success: boolean }>,

  // Events
  onProgress: (callback: (progress: UploadProgress) => void) => {
    ipcRenderer.on('upload:progress', (_, data) => callback(data as UploadProgress));
  },
  onQuickQueryToggle: (callback: (state: QuickQueryToggleState) => void) => {
    ipcRenderer.on('quick-query:toggle', (_, state) => callback(state as QuickQueryToggleState));
  },
  onQuickQuerySubmit: (callback: (payload: QuickQueryPayload) => void) => {
    ipcRenderer.on('quick-query:submit', (_, payload) => callback(payload as QuickQueryPayload));
  },
  onUpdateStatus: (callback: (payload: UpdateStatusPayload) => void) => {
    ipcRenderer.on('update:status', (_, payload) => callback(payload as UpdateStatusPayload));
  },
  onUpdateProgress: (callback: (percent: number) => void) => {
    ipcRenderer.on('update:progress', (_, data) => callback((data as { percent: number }).percent));
  },
  onFocusInput: (callback: () => void) => {
    ipcRenderer.on('focus-input', () => callback());
  },
  submitQuickQuery: (payload: string | QuickQueryPayload) =>
    ipcRenderer.invoke('quick-query:submit', payload) as Promise<{ success: boolean }>,
  hideQuickQuery: () => ipcRenderer.invoke('quick-query:hide') as Promise<{ success: boolean }>,
  checkForUpdates: () => ipcRenderer.invoke('updates:check') as Promise<{ success: boolean }>,
  downloadUpdate: () => ipcRenderer.invoke('updates:download') as Promise<{ success: boolean }>,
  restartToUpdate: () => ipcRenderer.invoke('updates:install') as Promise<{ success: boolean }>,

  // Shell
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url) as Promise<{ success: boolean }>,

  // Payment
  onPaymentComplete: (callback: (data: { success: boolean }) => void) => {
    ipcRenderer.on('payment-complete', (_, data) => callback(data as { success: boolean }));
  },
  removePaymentCompleteListener: () => {
    ipcRenderer.removeAllListeners('payment-complete');
  },

  // Claude Code credentials
  claudeCode: {
    hasCredentials: () =>
      ipcRenderer.invoke('claude:hasCredentials') as Promise<boolean>,
    syncCredentials: () =>
      ipcRenderer.invoke('claude:syncCredentials') as Promise<{ success: boolean; message?: string }>,
  },

  // Atlas credentials
  atlas: {
    storePassword: (password: string) =>
      ipcRenderer.invoke('atlas:storePassword', password) as Promise<{ success: boolean; error?: string }>,
    hasPassword: () =>
      ipcRenderer.invoke('atlas:hasPassword') as Promise<boolean>,
    clearPassword: () =>
      ipcRenderer.invoke('atlas:clearPassword') as Promise<{ success: boolean }>,
  },

  // WhatsApp
  whatsapp: {
    hasCredentials: () =>
      ipcRenderer.invoke('whatsapp:hasCredentials') as Promise<boolean>,
    getLinkedPhoneNumber: () =>
      ipcRenderer.invoke('whatsapp:getLinkedPhoneNumber') as Promise<string | null>,
    isConnected: () =>
      ipcRenderer.invoke('whatsapp:isConnected') as Promise<boolean>,
    connect: () =>
      ipcRenderer.invoke('whatsapp:connect') as Promise<{ success: boolean; error?: string }>,
    disconnect: () =>
      ipcRenderer.invoke('whatsapp:disconnect') as Promise<{ success: boolean; error?: string }>,
    logout: () =>
      ipcRenderer.invoke('whatsapp:logout') as Promise<{ success: boolean; error?: string }>,
  },

  // WhatsApp events
  onWhatsAppQRCode: (callback: (qr: string) => void) => {
    ipcRenderer.on('whatsapp:qrCode', (_, qr) => callback(qr as string));
  },

  // Telegram
  telegram: {
    hasSession: () =>
      ipcRenderer.invoke('telegram:hasSession') as Promise<boolean>,
    hasApiCredentials: () =>
      ipcRenderer.invoke('telegram:hasApiCredentials') as Promise<boolean>,
    isConnected: () =>
      ipcRenderer.invoke('telegram:isConnected') as Promise<boolean>,
    connectWithExistingSession: () =>
      ipcRenderer.invoke('telegram:connectWithExistingSession') as Promise<{ success: boolean; error?: string }>,
    disconnect: () =>
      ipcRenderer.invoke('telegram:disconnect') as Promise<{ success: boolean; error?: string }>,
    logout: () =>
      ipcRenderer.invoke('telegram:logout') as Promise<{ success: boolean; error?: string }>,
    syncHistorical: (messagesPerDialog?: number) =>
      ipcRenderer.invoke('telegram:syncHistorical', messagesPerDialog) as Promise<{ success: boolean; count?: number; error?: string }>,
    // Auth flow methods
    startAuth: (phoneNumber: string) =>
      ipcRenderer.invoke('telegram:startAuth', phoneNumber) as Promise<{ success: boolean; error?: string }>,
    submitCode: (code: string) =>
      ipcRenderer.invoke('telegram:submitCode', code) as Promise<{ success: boolean; error?: string }>,
    submitPassword: (password: string) =>
      ipcRenderer.invoke('telegram:submitPassword', password) as Promise<{ success: boolean; error?: string }>,
    cancelAuth: () =>
      ipcRenderer.invoke('telegram:cancelAuth') as Promise<{ success: boolean; error?: string }>,
  },

  // Telegram auth events
  onTelegramNeedCode: (callback: () => void) => {
    ipcRenderer.on('telegram:needCode', () => callback());
  },
  onTelegramNeedPassword: (callback: () => void) => {
    ipcRenderer.on('telegram:needPassword', () => callback());
  },
  onTelegramAuthComplete: (callback: () => void) => {
    ipcRenderer.on('telegram:authComplete', () => callback());
  },
  onTelegramAuthError: (callback: (error: string) => void) => {
    ipcRenderer.on('telegram:authError', (_, error) => callback(error as string));
  },
};

contextBridge.exposeInMainWorld('api', api);

// TypeScript declaration for renderer
declare global {
  interface Window {
    api: IPC;
  }
}

