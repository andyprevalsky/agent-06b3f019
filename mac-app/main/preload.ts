import { contextBridge, ipcRenderer } from 'electron';
import type {
  IPC,
  AuthSession,
  UploadResult,
  CookieData,
  UploadProgress,
  QuickQueryToggleState,
  QuickQueryPayload,
  DirectIMessagePayload,
  UpdateStatusPayload,
  ShortcutConfig,
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
  
  // Cookies
  readChromeCookies: () => ipcRenderer.invoke('cookies:readChrome') as Promise<CookieData[]>,
  uploadCookies: (data: CookieData[]) =>
    ipcRenderer.invoke('cookies:upload', data) as Promise<UploadResult>,
  
  // System
  openFullDiskAccessSettings: () => ipcRenderer.invoke('system:openFullDiskAccess') as Promise<{ success: boolean }>,
  
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
};

contextBridge.exposeInMainWorld('api', api);

// TypeScript declaration for renderer
declare global {
  interface Window {
    api: IPC;
  }
}

