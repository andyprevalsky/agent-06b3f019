export const config = {
  apiUrl: process.env.VITE_BACKEND_URL || 'http://localhost:3001',
  supabase: {
    url: process.env.VITE_SUPABASE_URL!,
    anonKey: process.env.VITE_SUPABASE_ANON_KEY!,
  },
  encryptionKey: process.env.ENCRYPTION_KEY || 'dev-only-change-in-production',
  isDev: process.env.NODE_ENV === 'development',
};

if (!config.supabase.url || !config.supabase.anonKey) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY');
}


