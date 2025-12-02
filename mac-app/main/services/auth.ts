import Store from 'electron-store';
import { config } from '../base/config';
import type { AuthSession } from '../../shared/types/ipc';

interface SupabaseTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: any;
}

const store = new Store<{ session: AuthSession | null }>({
  name: 'navi-auth',
  encryptionKey: config.encryptionKey,
});

const toMillis = (value: number | undefined | null) => {
  if (!value) return value ?? null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
};

const normalizeSession = (session: AuthSession | null): AuthSession | null => {
  if (!session) return null;
  const expiresAtMs = toMillis(session.expires_at);
  if (!expiresAtMs) return session;
  if (expiresAtMs === session.expires_at) return session;
  return {
    ...session,
    expires_at: expiresAtMs,
  };
};

export class AuthService {
  static async getSession(): Promise<AuthSession | null> {
    const stored = store.get('session');
    const session = normalizeSession(stored);
    if (!session) return null;
    
    if (session !== stored) {
      store.set('session', session);
    }
    
    // If expired or about to expire (within 60 seconds), try to refresh
    const bufferMs = 60 * 1000; // 60 second buffer
    if (Date.now() >= session.expires_at - bufferMs) {
      console.log('[AuthService] Token expired or expiring soon, attempting refresh...');
      const refreshed = await this.refreshToken(session.refresh_token);
      if (refreshed) {
        return refreshed;
      }
      // If refresh failed and token is actually expired, clear session
      if (Date.now() >= session.expires_at) {
        this.clearSession();
        return null;
      }
    }
    
    return session;
  }
  
  private static async refreshToken(refreshToken: string): Promise<AuthSession | null> {
    try {
      const response = await fetch(
        `${config.supabase.url}/auth/v1/token?grant_type=refresh_token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': config.supabase.anonKey,
          },
          body: JSON.stringify({ refresh_token: refreshToken }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[AuthService] Token refresh failed:', response.status, errorText);
        return null;
      }

      const data = await response.json() as SupabaseTokenResponse;
      
      // Supabase returns expires_in (seconds), we need to calculate expires_at (ms timestamp)
      const newSession: AuthSession = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in * 1000),
        user: data.user,
      };
      
      this.setSession(newSession);
      console.log('[AuthService] ✅ Token refreshed successfully');
      return newSession;
    } catch (error) {
      console.error('[AuthService] Token refresh error:', error);
      return null;
    }
  }
  
  static setSession(session: AuthSession): void {
    const normalized = normalizeSession(session);
    if (!normalized) {
      this.clearSession();
      return;
    }
    store.set('session', normalized);
  }
  
  static clearSession(): void {
    store.delete('session');
  }
}
