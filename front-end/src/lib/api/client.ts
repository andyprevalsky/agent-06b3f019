import { getSession } from '../supabase';
import { BACKEND_BASE_URL } from '../backendUrl';
import { isBenchmarkArchiveMode } from '../benchmarkArchive';

// API Configuration
export const API_BASE_URL = BACKEND_BASE_URL;
export const API_BASE_WITH_PATH = API_BASE_URL.endsWith('/api')
  ? API_BASE_URL
  : `${API_BASE_URL}/api`;

/**
 * Get auth headers for API requests.
 */
export function getAuthHeaders(): Record<string, string> {
  if (isBenchmarkArchiveMode()) {
    return {
      'Content-Type': 'application/json',
      'X-Benchmark-Archive': '1',
    };
  }

  const session = getSession();
  const token = session?.access_token;

  if (token) {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  throw new Error('Not authenticated');
}
