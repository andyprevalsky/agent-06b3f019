/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_REACT_GRAB?: 'true' | 'false';
  readonly VITE_REALTIME_PRIVATE?: 'true' | 'false';
  readonly VITE_BACKEND_SAME_ORIGIN?: 'true' | 'false';
}

interface ElectronAuthBridge {
  check: () => Promise<unknown>;
  save: (session: unknown) => Promise<{ success: boolean }>;
  clear: () => Promise<{ success: boolean }>;
}

/** Mac app local code runner (mac-app/shared/types/ipc.ts `localCode`); the part the web UI calls. */
interface ElectronLocalCodeBridge {
  openTerminal: (taskId: string) => Promise<{ success: boolean }>;
}

interface ElectronApiBridge {
  isElectron?: boolean;
  auth?: ElectronAuthBridge;
  localCode?: ElectronLocalCodeBridge;
}

declare interface Window {
  api?: ElectronApiBridge;
}
