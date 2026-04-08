/**
 * STATE MACHINE: IntegrationHandlersContext
 *
 * This context is stateless - provides integration handlers from Mac app.
 * Handlers are passed in via props from main.tsx.
 *
 * [MOUNTED] --> provides handlers: { iMessage?, chromeCookies?, browserCookies? }
 *
 * Each handler has:
 * - onClick: async function to execute integration
 * - isAvailable: boolean (whether feature is available in current environment)
 *
 * browserCookies handler provides multi-browser support:
 * - getInstalledBrowsers(): returns list of installed browsers
 * - syncBrowser(type, password?): syncs full browser state (cookies + localStorage + etc)
 * - syncBrowserPasswords(type): syncs ONLY passwords (not full browser state)
 * - storeAtlasPassword(password): stores Atlas password locally
 * - openKeychainAccess(searchQuery?): opens Keychain Access app
 */

import { createContext, useContext, ReactNode } from 'react';

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

const IntegrationHandlersContext = createContext<IntegrationHandlers>({});

export function IntegrationHandlersProvider({
  children,
  handlers,
}: {
  children: ReactNode;
  handlers?: IntegrationHandlers;
}) {
  return (
    <IntegrationHandlersContext.Provider value={handlers || {}}>
      {children}
    </IntegrationHandlersContext.Provider>
  );
}

export function useIntegrationHandlers() {
  return useContext(IntegrationHandlersContext);
}
