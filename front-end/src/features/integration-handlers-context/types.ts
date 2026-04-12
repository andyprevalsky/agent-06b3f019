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

export interface IntegrationHandlers {
  iMessage?: IntegrationHandler;
  chromeCookies?: IntegrationHandler;
  browserCookies?: BrowserCookiesHandler;
  claudeCode?: ClaudeCodeHandler;
}
