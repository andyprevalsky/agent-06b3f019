export type BrowserType =
  'chrome' | 'edge' | 'brave' | 'arc' | 'opera' | 'vivaldi' | 'chromium' | 'atlas' | 'safari';

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

/**
 * WhatsApp pairing is desktop-only: linking a device needs a QR scan driven by the
 * native bridge. The desktop shell owns the whole flow (QR display included) and
 * resolves `connect()` once pairing settles, so the shared UI needs no QR knowledge
 * -- only whether a desktop bridge exists.
 */
export interface WhatsAppHandler {
  isAvailable: boolean;
  connect: () => Promise<{ success: boolean; error?: string }>;
}

export interface IntegrationHandlers {
  iMessage?: IntegrationHandler;
  whatsApp?: WhatsAppHandler;
  chromeCookies?: IntegrationHandler;
  browserCookies?: BrowserCookiesHandler;
  claudeCode?: ClaudeCodeHandler;
  gptCode?: ClaudeCodeHandler;
  passkeys?: PasskeysHandler;
}
