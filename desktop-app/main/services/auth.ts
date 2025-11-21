import Store from 'electron-store';
import { config } from '../base/config';
import type { AuthSession } from '../../shared/types/ipc';

const store = new Store<{ session: AuthSession | null }>({
  name: 'navi-auth',
  encryptionKey: config.encryptionKey,
});

export class AuthService {
  static getSession(): AuthSession | null {
    const session = store.get('session');
    if (!session) return null;
    
    // Check expiration
    if (Date.now() >= session.expires_at) {
      this.clearSession();
      return null;
    }
    
    return session;
  }
  
  static setSession(session: AuthSession): void {
    store.set('session', session);
  }
  
  static clearSession(): void {
    store.delete('session');
  }
}


