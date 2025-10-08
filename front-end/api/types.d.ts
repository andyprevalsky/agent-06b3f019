// Type definitions for Vercel Edge Runtime
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      VITE_SUPABASE_URL: string;
      VITE_SUPABASE_ANON_KEY: string;
      SUPABASE_SERVICE_ROLE_KEY: string;
      NODE_ENV?: 'development' | 'production' | 'test';
    }
  }
}

export {};


