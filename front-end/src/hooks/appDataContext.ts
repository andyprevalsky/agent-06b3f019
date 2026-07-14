import { createContext, useContext } from 'react';

import type { Tool as ApiTool } from '@/lib/api';
import type { Model } from './useAppData';

export interface AppDataContextValue {
  models: Model[];
  modelsLoading: boolean;
  modelsError: string | null;
  tools: ApiTool[];
  toolsLoading: boolean;
  toolsError: string | null;
  refreshModels: () => Promise<void>;
  refreshTools: () => Promise<void>;
}

export const AppDataContext = createContext<AppDataContextValue | undefined>(undefined);

export function useAppData() {
  const context = useContext(AppDataContext);
  if (context === undefined) throw new Error('useAppData must be used within an AppDataProvider');
  return context;
}
