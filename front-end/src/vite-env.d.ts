/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_REALTIME_PRIVATE?: 'true' | 'false';
}

interface ElectronAuthBridge {
  check: () => Promise<unknown>;
  save: (session: unknown) => Promise<{ success: boolean }>;
  clear: () => Promise<{ success: boolean }>;
}

interface ElectronApiBridge {
  isElectron?: boolean;
  auth?: ElectronAuthBridge;
}

declare interface Window {
  api?: ElectronApiBridge;
}
