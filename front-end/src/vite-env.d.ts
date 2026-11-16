/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_REACT_GRAB?: 'true' | 'false';
  readonly VITE_REALTIME_PRIVATE?: 'true' | 'false';
  readonly VITE_BACKEND_SAME_ORIGIN?: 'true' | 'false';
  /** Production build id (vite.config.ts); also published as /version.json. */
  readonly VITE_ROSE_BUILD_ID?: string;
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

/** `roseCli.importProject` request (mac-app/shared/types/ipc.ts RoseCliImportRequest). */
type ElectronRoseCliImportRequest =
  | { action: 'detect' }
  | {
      action: 'scan';
      folder: string;
      loginCode: string;
      apiUrl: string;
      project?: string;
      agent?: 'codex' | 'claude';
    }
  | { action: 'apply'; folder: string; plan: unknown; githubImport: boolean; apiUrl: string };

/**
 * One `rose import … --json` stdout object tagged with its runId; every run ends
 * with exactly one `{ runId, event: 'exit', code }`. A non-zero exit with no CLI
 * error event is preceded by `{ runId, event: 'error', message, canceled? }`.
 */
interface ElectronRoseCliImportEvent {
  runId: string;
  event?: string;
  code?: number | null;
  [key: string]: unknown;
}

/** Mac app `rose` CLI launcher at ~/.rose/bin/rose (mac-app/shared/types/ipc.ts `roseCli`). */
interface ElectronRoseCliBridge {
  ensureInstalled: () => Promise<{ success: boolean; path?: string; error?: string }>;
  pickProjectFolder: () => Promise<{ canceled: boolean; path?: string }>;
  importProject: (
    request: ElectronRoseCliImportRequest,
  ) => Promise<{ runId: string } | { error: string }>;
  onImportEvent: (listener: (event: ElectronRoseCliImportEvent) => void) => () => void;
  cancelImport: (runId: string) => Promise<void>;
}

interface ElectronApiBridge {
  isElectron?: boolean;
  openExternal?: (url: string) => Promise<unknown>;
  auth?: ElectronAuthBridge;
  localCode?: ElectronLocalCodeBridge;
  roseCli?: ElectronRoseCliBridge;
}

declare interface Window {
  api?: ElectronApiBridge;
}
