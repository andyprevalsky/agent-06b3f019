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


