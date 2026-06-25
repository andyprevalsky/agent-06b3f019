export type BrowserType =
  | 'chrome'
  | 'edge'
  | 'brave'
  | 'arc'
  | 'opera'
  | 'vivaldi'
  | 'chromium'
  | 'atlas'
  | 'safari';

export interface BrowserInfo {
  type: BrowserType;
  name: string;
  isInstalled: boolean;
  needsManualPassword: boolean;
}

export interface IntegrationHandler {
  onClick: () => Promise<void>;
  isAvailable: boolean;
}

export interface BrowserCookiesHandler {
  isAvailable: boolean;
  getInstalledBrowsers: () => Promise<BrowserInfo[]>;
  syncBrowser: (browserType: BrowserType, keychainPassword?: string) => Promise<void>;
  syncBrowserPasswords: (
    browserType: BrowserType,
    config?: { keychainPassword?: string },
  ) => Promise<{ success: boolean; message?: string }>;
  storeAtlasPassword: (password: string) => Promise<{ success: boolean; error?: string }>;
  openKeychainAccess: (searchQuery?: string) => Promise<{ success: boolean }>;
}

export interface ClaudeCodeHandler {
  isAvailable: boolean;
  hasCredentials: () => Promise<boolean>;
  syncCredentials: () => Promise<{ success: boolean; message?: string }>;
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

export interface PasskeysHandler {
  isAvailable: boolean;
  openAutoFillSettings?: () => Promise<AutoFillSettingsResult>;
  checkAutoFillSettings?: () => Promise<AutoFillSettingsResult>;
  openPasswordsApp?: () => Promise<{ success: boolean; message?: string }>;
  onImportComplete?: (callback: (result: PasskeyImportResult) => void) => () => void;
  enroll: (params: { url: string; rpMatch?: string }) => Promise<PasskeyEnrollResult>;
}

export interface IntegrationHandlers {
  iMessage?: IntegrationHandler;
  chromeCookies?: IntegrationHandler;
  browserCookies?: BrowserCookiesHandler;
  claudeCode?: ClaudeCodeHandler;
  gptCode?: ClaudeCodeHandler;
  passkeys?: PasskeysHandler;
}
