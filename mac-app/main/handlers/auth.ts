import { ipcMain } from 'electron';
import { AuthService } from '../services/auth';
import { SyncManager } from '../services/sync/SyncManager';
import { accessTokenIsImpersonated } from '../domains/auth/impersonation';
import { enrollPasskey } from '../domains/passkey-enroll/service';
import { importPasskeysFromToken } from '../domains/passkey-import/service';
import { getErrorMessage } from '../../shared/utils/error';
import { logConsole, logConsoleError, logIpc } from '../base/logger';
import { getLocalMachineDataSession } from './machine-session';

export function registerAuthHandlers(): void {
  ipcMain.handle('auth:check', async () => {
    logIpc('IN', 'auth:check');
    const session = await AuthService.getSession();
    logConsole('IPC Auth', 'check() called', { hasSession: !!session });
    logIpc('OUT', 'auth:check', { hasSession: !!session });
    return session;
  });

  ipcMain.handle('auth:save', async (_, session) => {
    logIpc('IN', 'auth:save', { tokenPreview: session?.access_token?.substring(0, 20) + '...' });
    logConsole('IPC Auth', 'save() called', { expiresAt: session?.expires_at });
    const impersonated = accessTokenIsImpersonated(session?.access_token);

    // Stop the previous identity before changing the token. Any watcher that
    // survives this boundary could wake up under the target user's session.
    await SyncManager.stopAll();
    AuthService.setSession(session);
    logConsole('IPC Auth', 'Session saved to store');

    if (impersonated) {
      logConsole('IPC Auth', 'Impersonated session saved — local syncs remain stopped');
      logIpc('OUT', 'auth:save', { success: true, impersonated: true });
      return { success: true };
    }

    await SyncManager.startAll();
    logIpc('OUT', 'auth:save', { success: true });
    return { success: true };
  });

  ipcMain.handle('auth:clear', async () => {
    logIpc('IN', 'auth:clear');
    logConsole('IPC Auth', 'clear() called');
    await SyncManager.stopAll();
    AuthService.clearSession();
    logIpc('OUT', 'auth:clear', { success: true });
    return { success: true };
  });
}

export function registerPasskeyHandlers(): void {
  ipcMain.handle('passkeys:enroll', async (_, params: { url: string; rpMatch?: string }) => {
    logIpc('IN', 'passkeys:enroll', { url: params?.url });
    try {
      const { session, error } = await getLocalMachineDataSession();
      if (!session) {
        logIpc('OUT', 'passkeys:enroll', { success: false, message: error });
        return { success: false, message: error };
      }
      const result = await enrollPasskey(params, session.access_token);
      logIpc('OUT', 'passkeys:enroll', result);
      return result;
    } catch (error) {
      logConsoleError('IPC', getErrorMessage(error));
      return { success: false, message: getErrorMessage(error) };
    }
  });

  ipcMain.handle('passkeys:importFromToken', async (_, token: string) => {
    logIpc('IN', 'passkeys:importFromToken', { tokenPreview: String(token).slice(0, 8) });
    try {
      const { session, error } = await getLocalMachineDataSession();
      if (!session) return { success: false, message: error };
      const result = await importPasskeysFromToken(token, session.access_token);
      logIpc('OUT', 'passkeys:importFromToken', result);
      return result;
    } catch (error) {
      logConsoleError('IPC', getErrorMessage(error));
      return { success: false, message: getErrorMessage(error) };
    }
  });
}
