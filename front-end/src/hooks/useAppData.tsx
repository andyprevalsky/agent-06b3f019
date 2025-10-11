import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { getTools, Tool as ApiTool } from '@/lib/api';

// Re-export Tool type for convenience
export type Tool = ApiTool;

export interface Model {
  id: string;
  name: string;
  provider: string;
  description?: string;
  contextLength?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

interface AppDataContextType {
  models: Model[];
  modelsLoading: boolean;
  modelsError: string | null;
  tools: ApiTool[];
  toolsLoading: boolean;
  toolsError: string | null;
  refreshModels: () => Promise<void>;
  refreshTools: () => Promise<void>;
}

const AppDataContext = createContext<AppDataContextType | undefined>(undefined);

const BACKEND_API_URL = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001';

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [models, setModels] = useState<Model[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const [tools, setTools] = useState<ApiTool[]>([]);
  const [toolsLoading, setToolsLoading] = useState(true);
  const [toolsError, setToolsError] = useState<string | null>(null);

  const fetchModels = async () => {
    try {
      setModelsLoading(true);
      setModelsError(null);

      const response = await fetch(`${BACKEND_API_URL}/api/models`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.statusText}`);
      }

      const data = await response.json();
      setModels(data.models || []);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load models';
      setModelsError(errorMessage);
      console.error('Error fetching models:', err);
      // Set empty array on error to prevent undefined
      setModels([]);
    } finally {
      setModelsLoading(false);
    }
  };

  const fetchTools = async () => {
    try {
      setToolsLoading(true);
      setToolsError(null);

      const data = await getTools();
      setTools(data || []);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load tools';
      setToolsError(errorMessage);
      console.error('Error fetching tools:', err);
      // Set empty array on error to prevent undefined
      setTools([]);
    } finally {
      setToolsLoading(false);
    }
  };

  // Fetch on mount (page load)
  useEffect(() => {
    fetchModels();
    fetchTools();
  }, []);

  return (
    <AppDataContext.Provider
      value={{
        models,
        modelsLoading,
        modelsError,
        tools,
        toolsLoading,
        toolsError,
        refreshModels: fetchModels,
        refreshTools: fetchTools,
      }}
    >
      {children}
    </AppDataContext.Provider>
  );
}

export function useAppData() {
  const context = useContext(AppDataContext);
  if (context === undefined) {
    throw new Error('useAppData must be used within an AppDataProvider');
  }
  return context;
}

