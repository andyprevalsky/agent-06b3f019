// IPC method signatures
export interface IPC {
  auth: {
    check: () => Promise<AuthSession | null>;
    save: (session: AuthSession) => Promise<{ success: boolean }>;
    clear: () => Promise<{ success: boolean }>;
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

  // Quick query actions
  submitQuickQuery: (payload: string | QuickQueryPayload) => Promise<{ success: boolean }>;
  hideQuickQuery: () => Promise<{ success: boolean }>;
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
  contact_name: string;
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

