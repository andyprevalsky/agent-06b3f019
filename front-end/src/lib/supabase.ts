import { createClient, type Session, type User } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables');
}

type StorageAdapter = {
  getItem: (key: string) => string | null | Promise<string | null>;
  setItem: (key: string, value: string) => void | Promise<void>;
  removeItem: (key: string) => void | Promise<void>;
};

// Check if we're actually running in Electron (not just web with window.api potentially defined)
const isElectron = () => {
  if (typeof window === 'undefined') return false;
  // Check for Electron-specific properties
  const result = !!(window.api?.auth && typeof window.api.auth.check === 'function');
  console.log('[Supabase] isElectron check:', result, 'window.api:', !!window.api, 'window.api?.auth:', !!window.api?.auth);
  return result;
};

// In-memory storage for non-session Supabase keys (like PKCE code verifiers)
// This is needed because the Electron auth bridge only stores the session
const auxiliaryStorage = new Map<string, string>();
let cachedSession: Session | null = null;

const SUPABASE_SESSION_PREFIX = 'sb-';
const SUPABASE_SESSION_SUFFIX = '-auth-token';
const USER_CACHE_KEY = 'app-user';

const findSupabaseSessionKey = (): string | null => {
  if (typeof window === 'undefined') return null;
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key && key.startsWith(SUPABASE_SESSION_PREFIX) && key.endsWith(SUPABASE_SESSION_SUFFIX)) {
      return key;
    }
  }
  return null;
};

export const getStoredSession = (): Session | null => {
  if (cachedSession) {
    return cachedSession;
  }
  if (typeof window === 'undefined') return null;
  const key = findSupabaseSessionKey();
  if (!key) return null;
  const stored = window.localStorage.getItem(key);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored);
    cachedSession = parsed;
    return parsed;
  } catch (error) {
    console.warn('[Supabase] Failed to parse stored session', error);
    return null;
  }
};

export const clearStoredSession = () => {
  if (typeof window === 'undefined') return;
  cachedSession = null;
  if (window.api?.auth) {
    window.api.auth.clear().catch((error: unknown) => {
      console.warn('[Supabase] Failed to clear Electron auth session', error);
    });
  }
  const key = findSupabaseSessionKey();
  if (key) {
    window.localStorage.removeItem(key);
  }
};

export const persistCachedUser = (user: User | null) => {
  if (typeof window === 'undefined') return;
  if (user) {
    window.localStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
  } else {
    window.localStorage.removeItem(USER_CACHE_KEY);
  }
};

export const getCachedUser = (): User | null => {
  if (typeof window === 'undefined') return null;
  const stored = window.localStorage.getItem(USER_CACHE_KEY);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch (error) {
    console.warn('[Supabase] Failed to parse cached user', error);
    return null;
  }
};

const getElectronStorage = (): StorageAdapter | undefined => {
  if (!isElectron()) return undefined;
  const authBridge = window.api!.auth!;

  return {
    getItem: async (key: string) => {
      // For session token, use the auth bridge
      if (key.endsWith('-auth-token') && !key.includes('code-verifier')) {
        const session = await authBridge.check();
        if (session) {
          cachedSession = session;
        }
        return session ? JSON.stringify(session) : null;
      }
      // For other keys (like code verifier), use auxiliary storage
      return auxiliaryStorage.get(key) ?? null;
    },
    setItem: async (key: string, value: string) => {
      // For session token, use the auth bridge
      if (key.endsWith('-auth-token') && !key.includes('code-verifier')) {
        if (!value) {
          await authBridge.clear();
          return;
        }
        try {
          const session = JSON.parse(value);
          await authBridge.save(session);
          cachedSession = session;
        } catch (error) {
          console.warn('[Supabase] Failed to parse session for Electron storage', error);
        }
        return;
      }
      // For other keys (like code verifier), use auxiliary storage
      if (value) {
        auxiliaryStorage.set(key, value);
      } else {
        auxiliaryStorage.delete(key);
      }
    },
    removeItem: async (key: string) => {
      // For session token, use the auth bridge
      if (key.endsWith('-auth-token') && !key.includes('code-verifier')) {
        await authBridge.clear();
        cachedSession = null;
        return;
      }
      // For other keys, use auxiliary storage
      auxiliaryStorage.delete(key);
    },
  };
};

// Only use custom storage for Electron - let Supabase use its default localStorage for web
const electronStorage = getElectronStorage();

if (typeof window !== 'undefined' && window.api?.auth) {
  window.api.auth
    .check()
    .then((session) => {
      cachedSession = session ?? null;
    })
    .catch((error) => {
      console.warn('[Supabase] Failed to prime cached session from Electron bridge', error);
    });
}

console.log('[Supabase] 🔧 Environment:', electronStorage ? 'Electron (custom storage)' : 'Web (default localStorage)');

const supabaseAuthConfig: {
  autoRefreshToken: boolean;
  persistSession: boolean;
  detectSessionInUrl: boolean;
  storage?: StorageAdapter;
} = {
  autoRefreshToken: true,
  persistSession: true,
  detectSessionInUrl: false,
};

// IMPORTANT: Only set storage for Electron. For web, let Supabase use its built-in localStorage handling.
// Explicitly passing localStorage can interfere with Supabase's internal initialization.
if (electronStorage) {
  supabaseAuthConfig.storage = electronStorage;
}

console.log('[Supabase] 🏗️ Creating Supabase client...');
console.log('[Supabase] 📋 Using custom storage:', !!electronStorage);

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: supabaseAuthConfig,
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
  db: {
    schema: 'public',
  },
  global: {
    headers: {
      'X-Client-Info': 'supabase-js-web',
    },
  },
});

console.log('[Supabase] ✅ Supabase client created');
console.log('[Supabase] 📋 supabase.auth:', !!supabase.auth);

// API Configuration for auth endpoints
const API_BASE_URL = (import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001').replace(/\/$/, '');

// Phone Auth helpers - now routed through backend for user initialization
export const sendOTP = async (phone: string) => {
  const response = await fetch(`${API_BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ phone }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Failed to send OTP');
  }

  return data;
};

export const verifyOTP = async (phone: string, token: string) => {
  const response = await fetch(`${API_BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ phone, token }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Invalid OTP');
  }

  // Set the session in Supabase client so other parts of the app work
  if (data.session?.access_token) {
    await supabase.auth.setSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
  }

  return { user: data.user, session: data.session };
};

export const signOut = async () => {
  console.log('[Supabase] signOut() called');
  const start = performance.now();
  const timeoutMs = 3000;
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      console.warn('[Supabase] signOut() timed out after', timeoutMs, 'ms. Proceeding with manual cleanup.');
      resolve(null);
    }, timeoutMs);
  });

  const response = (await Promise.race([
    supabase.auth.signOut({ scope: 'local' }),
    timeoutPromise,
  ])) as { error: Error | null } | null;
  if (timeoutId) {
    clearTimeout(timeoutId);
  }

  const duration = performance.now() - start;
  console.log('[Supabase] signOut() finished', { durationMs: duration.toFixed(2), timedOut, error: response?.error ?? null });

  if (!timedOut && response?.error) {
    throw response.error;
  }
};

export const getCurrentUser = async () => {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error) throw error;
  return user;
};

export const getSession = async () => {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) throw error;
  return session;
};

// Initialize realtime with current auth token
// Call this after authentication succeeds
export const initializeRealtime = async () => {
  const { data: { session } } = await supabase.auth.getSession();
  
  if (session?.access_token) {
    await supabase.realtime.setAuth(session.access_token);
  }
};
