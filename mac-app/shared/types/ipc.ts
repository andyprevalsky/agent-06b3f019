// Shortcut configuration
export interface ShortcutConfig {
  modifiers: string[];
  key: string;
}

// Browser types for multi-browser cookie sync
export type BrowserType =
  'chrome' | 'edge' | 'brave' | 'arc' | 'opera' | 'vivaldi' | 'chromium' | 'atlas' | 'safari';

export interface BrowserInfo {
  type: BrowserType;
  name: string;
  isInstalled: boolean;
  needsManualPassword: boolean;
}

export interface ReadBrowserCookiesConfig {
  keychainPassword?: string;
}

export interface PasskeyEnrollParams {
  /** URL to open (the site's login & security / add-a-passkey page). */
  url: string;
  /** Optional rpId to match; defaults to the URL's hostname. */
  rpMatch?: string;
}

export interface PasskeyEnrollResult {
  success: boolean;
  rpId?: string;
  credentialId?: string;
  message?: string;
}

export interface PasskeyImportResult {
  success: boolean;
  count?: number;
  passkeyCount?: number;
  passwordCount?: number;
  message?: string;
}

export interface AutoFillSettingsResult {
  success: boolean;
  enabled?: boolean;
  credentialExchangeEnabled?: boolean;
  openedSettings?: boolean;
  openedPasswordsApp?: boolean;
  message?: string;
}

// IPC method signatures
export interface IPC {
  readonly isElectron: true;
  auth: {
    check: () => Promise<AuthSession | null>;
    save: (session: AuthSession) => Promise<{ success: boolean }>;
    clear: () => Promise<{ success: boolean }>;
  };

  // Shortcut configuration
  shortcut?: {
    get: () => Promise<ShortcutConfig | null>;
    set: (config: ShortcutConfig) => Promise<{ success: boolean }>;
    validate: (config: ShortcutConfig) => Promise<{ available: boolean }>;
    enable: () => Promise<{ success: boolean; enabled: boolean }>;
    disable: () => Promise<{ success: boolean; enabled: boolean }>;
    isEnabled: () => Promise<{ enabled: boolean }>;
  };

  // Onboarding state
  onboarding?: {
    isComplete: () => Promise<boolean>;
    setComplete: (complete: boolean) => Promise<{ success: boolean }>;
    getLastAuthProvider: () => Promise<string | null>;
    setLastAuthProvider: (provider: string) => Promise<{ success: boolean }>;
  };

  // iMessage
  checkIMessageAccess: () => Promise<boolean>;
  startIMessageUpload: () => Promise<UploadResult>;
  sendIMessage: (payload: DirectIMessagePayload) => Promise<{ success: boolean; message?: string }>;

  // Cookies (legacy Chrome-only methods)
  readChromeCookies: () => Promise<CookieData[]>;
  uploadCookies: (data: CookieData[]) => Promise<UploadResult>;

  // Browser cookies (multi-browser support)
  getInstalledBrowsers: () => Promise<BrowserInfo[]>;
  readBrowserCookies: (
    browser: BrowserType,
    config?: ReadBrowserCookiesConfig
  ) => Promise<CookieData[]>;
  uploadBrowserCookies: (browser: BrowserType, data: CookieData[]) => Promise<UploadResult>;

  // Full browser sync (cookies + localStorage + IndexedDB + permissions + Cache Storage in parallel)
  syncBrowser: (browser: BrowserType, config?: ReadBrowserCookiesConfig) => Promise<UploadResult>;

  // Password-only sync (just reads and uploads passwords, not full browser state)
  // For Atlas, pass keychainPassword in config
  syncBrowserPasswords: (
    browser: BrowserType,
    config?: { keychainPassword?: string }
  ) => Promise<UploadResult>;

  // Passkeys: mint an exportable agent passkey via a CDP virtual authenticator
  // in an Electron window and upload it to the backend.
  passkeys?: {
    enroll: (params: PasskeyEnrollParams) => Promise<PasskeyEnrollResult>;
  };

  // Fingerprint
  collectFingerprint: () => Promise<FingerprintData | null>;
  uploadFingerprint: (data: FingerprintData) => Promise<UploadResult>;

  // System
  openFullDiskAccessSettings: () => Promise<{ success: boolean }>;
  openKeychainAccess: (searchQuery?: string) => Promise<{ success: boolean }>;
  openPasswordsApp: () => Promise<{ success: boolean }>;
  openAutoFillSettings: () => Promise<AutoFillSettingsResult>;
  checkAutoFillSettings: () => Promise<AutoFillSettingsResult>;

  // Events
  onProgress: (callback: (progress: UploadProgress) => void) => void;
  onQuickQueryToggle: (callback: (state: QuickQueryToggleState) => void) => void;
  /**
   * `claim` resolves true once the main process has given this submit up to the
   * caller; act on the submit only then. Until claimed it stays held there.
   */
  onQuickQuerySubmit: (
    callback: (payload: QuickQueryPayload, claim: () => Promise<boolean>) => void
  ) => () => void;
  onUpdateStatus: (callback: (payload: UpdateStatusPayload) => void) => void;
  onUpdateProgress: (callback: (percent: number) => void) => void;
  onFocusInput: (callback: () => void) => void;
  onOpenAgent: (callback: (agentId: string) => void) => () => void;

  // Quick query actions
  submitQuickQuery: (payload: string | QuickQueryPayload) => Promise<{ success: boolean }>;
  hideQuickQuery: () => Promise<{ success: boolean }>;
  resizeQuickQuery: (payload: QuickQueryResizePayload) => Promise<{ success: boolean }>;
  /** Keep the launcher visible while an OS file-drag is over it (cancels blur-hide). */
  setQuickQueryFileDrag: (payload: { active: boolean }) => Promise<{ success: boolean }>;
  checkForUpdates: () => Promise<{ success: boolean }>;
  downloadUpdate: () => Promise<{ success: boolean }>;
  restartToUpdate: () => Promise<{ success: boolean }>;

  // Shell
  openExternal: (url: string) => Promise<{ success: boolean }>;

  // Payment events
  onPaymentComplete: (callback: (data: { success: boolean }) => void) => void;
  removePaymentCompleteListener: () => void;
  onPasskeysImportComplete?: (callback: (result: PasskeyImportResult) => void) => () => void;

  // Claude Code credentials
  claudeCode?: {
    hasCredentials: () => Promise<boolean>;
    syncCredentials: () => Promise<{ success: boolean; message?: string }>;
    setMockNoClaudeCode: (mock: boolean) => Promise<{ success: boolean }>;
  };

  // GPT/Codex credentials
  gptCode?: {
    hasCredentials: () => Promise<boolean>;
    syncCredentials: () => Promise<{ success: boolean; message?: string }>;
  };

  // Claude Code setup status events
  onClaudeSetupStatus?: (callback: (status: string) => void) => () => void;

  // Codex/ChatGPT setup status events (install + `codex login` progress)
  onGptSetupStatus?: (callback: (status: string) => void) => () => void;

  // Local code agents on this Mac (C14): device, folder grants, live sessions
  localCode?: {
    getStatus: () => Promise<LocalCodeStatus>;
    /** Without a path, opens the macOS folder picker. */
    addGrant: (path?: string) => Promise<LocalCodeGrantResult>;
    removeGrant: (grantId: string) => Promise<LocalCodeGrantResult>;
    setDefaultGrant: (grantId: string) => Promise<LocalCodeGrantResult>;
    openTerminal: (taskId: string) => Promise<{ success: boolean }>;
    onStatus: (callback: (status: LocalCodeStatus) => void) => () => void;
  };

  // Atlas credentials
  atlas?: {
    storePassword: (password: string) => Promise<{ success: boolean; error?: string }>;
    hasPassword: () => Promise<boolean>;
    clearPassword: () => Promise<{ success: boolean }>;
  };

  // WhatsApp
  whatsapp?: {
    hasCredentials: () => Promise<boolean>;
    getLinkedPhoneNumber: () => Promise<string | null>;
    isConnected: () => Promise<boolean>;
    connect: () => Promise<{ success: boolean; error?: string }>;
    disconnect: () => Promise<{ success: boolean; error?: string }>;
    logout: () => Promise<{ success: boolean; error?: string }>;
  };

  // WhatsApp events
  onWhatsAppQRCode?: (callback: (qr: string) => void) => () => void;

  // Telegram
  telegram?: {
    hasSession: () => Promise<boolean>;
    hasApiCredentials: () => Promise<boolean>;
    isConnected: () => Promise<boolean>;
    connectWithExistingSession: () => Promise<{ success: boolean; error?: string }>;
    disconnect: () => Promise<{ success: boolean; error?: string }>;
    logout: () => Promise<{ success: boolean; error?: string }>;
    syncHistorical: (
      messagesPerDialog?: number
    ) => Promise<{ success: boolean; count?: number; error?: string }>;
    // Auth flow methods
    startAuth: (phoneNumber: string) => Promise<{ success: boolean; error?: string }>;
    submitCode: (code: string) => Promise<{ success: boolean; error?: string }>;
    submitPassword: (password: string) => Promise<{ success: boolean; error?: string }>;
    cancelAuth: () => Promise<{ success: boolean; error?: string }>;
  };

  // Telegram auth events
  onTelegramNeedCode?: (callback: () => void) => void;
  onTelegramNeedPassword?: (callback: () => void) => void;
  onTelegramAuthComplete?: (callback: () => void) => void;
  onTelegramAuthError?: (callback: (error: string) => void) => void;
}

// Data types
export interface AuthSession {
  access_token: string;
  refresh_token: string;
  user: unknown;
  expires_at: number;
}

export interface IMessageData {
  id: number;
  text: string;
  date: number;
  is_from_me: boolean;
  contact_id: string;
  contact_name: string | null;
  contact_firstName?: string | null;
  contact_lastName?: string | null;
  contact_email?: string | null;
  contact_company?: string | null;
  contact_title?: string | null;
  contact_emailAddresses?: string[];
}

export interface IMessageUploadMessage {
  id: number;
  text: string;
  date: number;
  is_from_me: boolean;
  contactHandle?: string;
}

export interface IMessageUploadContact {
  contact_id: string;
  contact_name: string | null;
  phoneNumber?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  title?: string | null;
  emailAddresses?: string[];
  messages: IMessageUploadMessage[];
}

export interface IMessageUploadPayload {
  contacts: IMessageUploadContact[];
}

export interface CookieData {
  host_key: string;
  name: string;
  value: string;
  path: string;
  expires_utc: number;
  is_secure: boolean;
  is_httponly: boolean;
  // Additional Chrome cookie fields
  creation_utc: number;
  top_frame_site_key: string;
  last_access_utc: number;
  has_expires: boolean;
  is_persistent: boolean;
  priority: number; // 0=Low, 1=Medium, 2=High
  samesite: number; // -1=Unspecified, 0=None, 1=Lax, 2=Strict
  source_scheme: number; // 0=Unset, 1=NonSecure, 2=Secure
  source_port: number;
  last_update_utc: number;
  browserProfile?: string;
}

export interface FingerprintData {
  navigator: {
    userAgent: string;
    platform: string;
    language: string;
    languages: string[];
    hardwareConcurrency: number;
    deviceMemory: number | null;
    maxTouchPoints: number;
    vendor: string;
    doNotTrack: string | null;
  };
  // Client Hints (navigator.userAgentData.getHighEntropyValues)
  userAgentData: {
    brands: Array<{ brand: string; version: string }>;
    mobile: boolean;
    platform: string;
    platformVersion: string;
    architecture: string;
    bitness: string;
    model: string;
    fullVersionList: Array<{ brand: string; version: string }>;
  } | null;
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
    pixelDepth: number;
    devicePixelRatio: number;
  };
  // Viewport dimensions (window.innerWidth/innerHeight)
  viewport: {
    innerWidth: number;
    innerHeight: number;
    outerWidth: number;
    outerHeight: number;
  };
  // Network Information API (navigator.connection)
  connection: {
    effectiveType: string;
    downlink: number;
    rtt: number;
    saveData: boolean;
  } | null;
  webgl: {
    vendor: string;
    renderer: string;
  };
  canvas: {
    hash: string;
  };
  audio: {
    hash: string;
  };
  timezone: string;
  // Timezone offset in minutes (for Date.getTimezoneOffset())
  timezoneOffset: number;
  fonts: string[];
  plugins: string[];
  collectedAt: string;
}

export interface UploadProgress {
  type: 'imessage' | 'cookies';
  percent: number;
}

export interface UploadResult {
  success: boolean;
  message?: string;
}

/**
 * Per-request options for a chunked messaging (contacts JSON) upload. A
 * chunked sync sends one `accessedAt` (its start) on every request and
 * `syncComplete: false` on all but the last, so the backend only advances the
 * incremental-read cursor once the whole sync has been delivered.
 */
export interface MessagingUploadOptions {
  accessedAt?: string;
  syncComplete?: boolean;
}

export interface DirectIMessagePayload {
  to: string;
  message: string;
}

/** File bytes carried with a quick-query submit (uploaded in the main window). */
export interface QuickQueryAttachment {
  name: string;
  mimeType: string;
  size: number;
  /** Raw file bytes — structured-clone / Electron-IPC safe. */
  data: ArrayBuffer;
  /** The screenshot captured when the launcher opened, not a file the user chose. */
  autoCaptured?: boolean;
}

export interface QuickQueryPayload {
  query: string;
  submittedAt: number;
  /** Optional local files; main window uploads these before createAgent. */
  attachments?: QuickQueryAttachment[];
}

/** A launcher submit the main process holds until the main window's consumer claims it. */
export interface QuickQueryHeldSubmit {
  id: string;
  payload: QuickQueryPayload;
}

export interface QuickQueryResizePayload {
  height: number;
}

export interface QuickQueryToggleState {
  open: boolean;
  /** Screen the launcher was summoned from, captured before it was shown. */
  screenshot?: QuickQueryAttachment;
}

export type UpdateStatusState =
  'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'none' | 'building' | 'error';

export interface UpdateStatusPayload {
  state: UpdateStatusState;
  version?: string;
  message?: string;
  percent?: number;
}

/** A folder the user shared with Rose for local code agents (C14). */
export interface LocalCodeFolderGrant {
  id: string;
  /** Absolute, symlink-resolved path. */
  path: string;
  /** Home-abbreviated display path, e.g. "~/Developer/rose". */
  label: string;
  createdAt: string;
  /** Used when an agent does not name a folder. */
  isDefault: boolean;
}

export interface LocalCodeSessionView {
  taskId: string;
  agentId: string;
  provider: 'claude' | 'codex';
  /** Display path of the folder the session runs in. */
  folder: string;
  startedAt: string;
}

export interface LocalCodeStatus {
  deviceId: string;
  /** The Mac's Computer Name, as shown in the C14 disconnected error. */
  deviceName: string;
  /** Control channel to the backend is open (this Mac can take local runs). */
  connected: boolean;
  grants: LocalCodeFolderGrant[];
  sessions: LocalCodeSessionView[];
}

export interface LocalCodeGrantResult {
  success: boolean;
  error?: string;
  status: LocalCodeStatus;
}
