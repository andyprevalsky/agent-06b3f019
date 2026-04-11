import { createContext, useContext } from 'react';

import type { IntegrationHandlers } from './types';

export const IntegrationHandlersContext = createContext<IntegrationHandlers>({});

export function useIntegrationHandlers() {
  return useContext(IntegrationHandlersContext);
}
