import Store from 'electron-store';
import { config } from '../base/config';
import type { AuthSession } from '../../shared/types/ipc';

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
  static getSession(): AuthSession | null {
    const stored = store.get('session');
    const session = normalizeSession(stored);
    if (!session) return null;
    
    if (session !== stored) {
      store.set('session', session);
    }
    
    if (Date.now() >= session.expires_at) {
      this.clearSession();
      return null;
    }
    
    return session;
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

