export const API_URL = (import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001').replace(
  /\/$/,
  '',
);
export const DOCS_URL = import.meta.env.DEV ? 'http://localhost:3002' : 'https://docs.roselabs.ai';
