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

/** Mac app WhatsApp bridge (mac-app/shared/types/ipc.ts `whatsapp`); the part the web UI calls. */
interface ElectronWhatsAppBridge {
  /** Pair one more account; the QR streams over `onWhatsAppQRCode`. */
  addAccount?: () => Promise<{ success: boolean; error?: string }>;
  /** Log out one account (E.164 phone); others stay connected. */
  logout: (accountId?: string) => Promise<{ success: boolean; error?: string }>;
}

interface ElectronApiBridge {
  isElectron?: boolean;
  auth?: ElectronAuthBridge;
  localCode?: ElectronLocalCodeBridge;
  whatsapp?: ElectronWhatsAppBridge;
}

declare interface Window {
  api?: ElectronApiBridge;
}
