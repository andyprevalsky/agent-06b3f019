/**
 * STATE MACHINE: IntegrationHandlersContext
 *
 * This context is stateless - provides integration handlers from Mac app.
 * Handlers are passed in via props from main.tsx.
 *
 * [MOUNTED] --> provides handlers: { iMessage?, chromeCookies? }
 *
 * Each handler has:
 * - onClick: async function to execute integration
 * - isAvailable: boolean (whether feature is available in current environment)
 */

import { createContext, useContext, ReactNode } from 'react';

export interface IntegrationHandler {
  onClick: () => Promise<void>;
  isAvailable: boolean;
}

export interface IntegrationHandlers {
  iMessage?: IntegrationHandler;
  chromeCookies?: IntegrationHandler;
}

const IntegrationHandlersContext = createContext<IntegrationHandlers>({});

export function IntegrationHandlersProvider({ 
  children, 
  handlers 
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


