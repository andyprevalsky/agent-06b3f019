import { useState, useEffect } from 'react';

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

interface UseModelsReturn {
  models: Model[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const BACKEND_API_URL = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001';

export function useModels(): UseModelsReturn {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchModels = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`${BACKEND_API_URL}/api/models`);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.statusText}`);
      }

      const data = await response.json();
      setModels(data.models || []);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load models';
      setError(errorMessage);
      console.error('Error fetching models:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchModels();
  }, []);

  return {
    models,
    loading,
    error,
    refresh: fetchModels,
  };
}

