import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: false, // We handle persistence via IPC
    detectSessionInUrl: false,
    storage: {
      // Custom storage synced with main process
      getItem: async (key: string) => {
        const session = await window.api.checkAuth();
        return session ? JSON.stringify(session) : null;
      },
      setItem: async (key: string, value: string) => {
        const session = JSON.parse(value);
        await window.api.saveAuth(session);
      },
      removeItem: async (key: string) => {
        await window.api.clearAuth();
      },
    },
  },
});

// Re-export phone auth helpers
export const sendOTP = async (phone: string) => {
  const { data, error } = await supabase.auth.signInWithOtp({
    phone,
    options: { shouldCreateUser: true },
  });
  if (error) throw error;
  return data;
};

export const verifyOTP = async (phone: string, token: string) => {
  const { data, error } = await supabase.auth.verifyOtp({
    phone,
    token,
    type: 'sms',
  });
  if (error) throw error;
  return data;
};


