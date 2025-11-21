import { contextBridge, ipcRenderer } from 'electron';
import type { IPC } from '../shared/types/ipc';

// Expose type-safe API to renderer
const api: IPC = {
  // Auth
  checkAuth: () => ipcRenderer.invoke('auth:check'),
  saveAuth: (session) => ipcRenderer.invoke('auth:save', session),
  clearAuth: () => ipcRenderer.invoke('auth:clear'),
  
  // iMessage
  checkIMessageAccess: () => ipcRenderer.invoke('imessage:checkAccess'),
  readIMessages: () => ipcRenderer.invoke('imessage:read'),
  uploadIMessages: (data) => ipcRenderer.invoke('imessage:upload', data),
  
  // Cookies
  readChromeCookies: () => ipcRenderer.invoke('cookies:readChrome'),
  uploadCookies: (data) => ipcRenderer.invoke('cookies:upload', data),
  
  // Events
  onProgress: (callback) => {
    ipcRenderer.on('upload:progress', (_, data) => callback(data));
  },
};

contextBridge.exposeInMainWorld('api', api);

// TypeScript declaration for renderer
declare global {
  interface Window {
    api: IPC;
  }
}


