import { BACKEND_BASE_URL } from '@/lib/backendUrl';

export const API_URL = BACKEND_BASE_URL;
export const DOCS_URL = import.meta.env.DEV ? 'http://localhost:3002' : 'https://docs.roselabs.ai';
