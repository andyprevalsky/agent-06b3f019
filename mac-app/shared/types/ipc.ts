// Shortcut configuration
export interface ShortcutConfig {
  modifiers: string[];
  key: string;
}

// Browser types for multi-browser cookie sync
export type BrowserType =
  | 'chrome'
  | 'edge'
  | 'brave'
  | 'arc'
  | 'opera'
  | 'vivaldi'
  | 'chromium'
  | 'atlas';

export interface BrowserInfo {
  type: BrowserType;
  name: string;
  isInstalled: boolean;
  needsManualPassword: boolean;
}

export interface ReadBrowserCookiesConfig {
  keychainPassword?: string;
}

// IPC method signatures
export interface IPC {
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
  readBrowserCookies: (browser: BrowserType, config?: ReadBrowserCookiesConfig) => Promise<CookieData[]>;
  uploadBrowserCookies: (browser: BrowserType, data: CookieData[]) => Promise<UploadResult>;

  // Fingerprint
  collectFingerprint: () => Promise<FingerprintData | null>;
  uploadFingerprint: (data: FingerprintData) => Promise<UploadResult>;

  // System
  openFullDiskAccessSettings: () => Promise<{ success: boolean }>;
  openKeychainAccess: (searchQuery?: string) => Promise<{ success: boolean }>;

  // Events
  onProgress: (callback: (progress: UploadProgress) => void) => void;
  onQuickQueryToggle: (callback: (state: QuickQueryToggleState) => void) => void;
  onQuickQuerySubmit: (callback: (payload: QuickQueryPayload) => void) => void;
  onUpdateStatus: (callback: (payload: UpdateStatusPayload) => void) => void;
  onUpdateProgress: (callback: (percent: number) => void) => void;
  onFocusInput: (callback: () => void) => void;

  // Quick query actions
  submitQuickQuery: (payload: string | QuickQueryPayload) => Promise<{ success: boolean }>;
  hideQuickQuery: () => Promise<{ success: boolean }>;
  checkForUpdates: () => Promise<{ success: boolean }>;
  downloadUpdate: () => Promise<{ success: boolean }>;
  restartToUpdate: () => Promise<{ success: boolean }>;

  // Shell
  openExternal: (url: string) => Promise<{ success: boolean }>;

  // Payment events
  onPaymentComplete: (callback: (data: { success: boolean }) => void) => void;
  removePaymentCompleteListener: () => void;

  // Atlas credentials
  atlas?: {
    storePassword: (password: string) => Promise<{ success: boolean; error?: string }>;
    hasPassword: () => Promise<boolean>;
    clearPassword: () => Promise<{ success: boolean }>;
  };
}

// Data types
export interface AuthSession {
  access_token: string;
  refresh_token: string;
  user: any;
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
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
    pixelDepth: number;
    devicePixelRatio: number;
  };
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

export interface DirectIMessagePayload {
  to: string;
  message: string;
}

export interface QuickQueryPayload {
  query: string;
  submittedAt: number;
}

export interface QuickQueryToggleState {
  open: boolean;
}

export type UpdateStatusState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'none'
  | 'building'
  | 'error';

export interface UpdateStatusPayload {
  state: UpdateStatusState;
  version?: string;
  message?: string;
  percent?: number;
}

