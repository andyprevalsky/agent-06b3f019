/** Backend API base URL (no trailing slash). */
export const API_URL = (import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001').replace(
  /\/$/,
  '',
);
