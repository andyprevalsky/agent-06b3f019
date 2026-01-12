// Shortcut configuration
export interface ShortcutConfig {
  modifiers: string[];
  key: string;
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

  // Cookies
  readChromeCookies: () => Promise<CookieData[]>;
  uploadCookies: (data: CookieData[]) => Promise<UploadResult>;

  // System
  openFullDiskAccessSettings: () => Promise<{ success: boolean }>;

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

