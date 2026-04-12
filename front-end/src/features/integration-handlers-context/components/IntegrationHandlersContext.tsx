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

import type { ReactNode } from 'react';

import type { IntegrationHandlers } from '../types';
import { IntegrationHandlersContext } from '../hooks';

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
