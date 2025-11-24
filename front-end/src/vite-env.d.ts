/// <reference types="vite/client" />

interface ElectronAuthBridge {
  check: () => Promise<any>;
  save: (session: any) => Promise<{ success: boolean }>;
  clear: () => Promise<{ success: boolean }>;
}

interface ElectronApiBridge {
  auth?: ElectronAuthBridge;
}

declare interface Window {
  api?: ElectronApiBridge;
}
