// IPC method signatures
export interface IPC {
  // Auth
  checkAuth: () => Promise<AuthSession | null>;
  saveAuth: (session: AuthSession) => Promise<{ success: boolean }>;
  clearAuth: () => Promise<{ success: boolean }>;
  
  // iMessage
  checkIMessageAccess: () => Promise<boolean>;
  readIMessages: () => Promise<IMessageData[]>;
  uploadIMessages: (data: IMessageData[]) => Promise<UploadResult>;
  
  // Cookies
  readChromeCookies: () => Promise<CookieData[]>;
  uploadCookies: (data: CookieData[]) => Promise<UploadResult>;
  
  // Events
  onProgress: (callback: (progress: UploadProgress) => void) => void;
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


