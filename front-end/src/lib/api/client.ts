import { getSession } from '../supabase';

// API Configuration
export const API_BASE_URL = (
  import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001'
).replace(/\/$/, '');
export const API_BASE_WITH_PATH = API_BASE_URL.endsWith('/api')
  ? API_BASE_URL
  : `${API_BASE_URL}/api`;

/**
 * Get auth headers for API requests.
 */
export function getAuthHeaders(): Record<string, string> {
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
