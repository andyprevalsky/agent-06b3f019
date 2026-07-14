/**
 * STATE MACHINE: useAppData (AppDataContext)
 *
 * MODELS LOADING:
 * [LOADING_MODELS] <-- modelsLoading: true
 *     |
 *     v (fetch complete)
 * [MODELS_READY] <-- modelsLoading: false, models: Model[]
 *   or
 * [MODELS_ERROR] <-- modelsError: string
 *
 * TOOLS LOADING:
 * [LOADING_TOOLS] <-- toolsLoading: true
 *     |
 *     v (fetch complete)
 * [TOOLS_READY] <-- toolsLoading: false, tools: Tool[]
 *   or
 * [TOOLS_ERROR] <-- toolsError: string
 *
 * Provides:
 * - models: Model[] (available LLM models)
 * - tools: Tool[] (available agent tools)
 * - refreshModels(), refreshTools() for manual refresh
 */

import React, { useState, useEffect, ReactNode } from 'react';
import { getTools, Tool as ApiTool } from '@/lib/api';
import { BACKEND_BASE_URL } from '@/lib/backendUrl';
import { AppDataContext } from './appDataContext';

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

// Normalize URL - strip trailing slash to prevent double slashes
const BACKEND_API_URL = BACKEND_BASE_URL;

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
