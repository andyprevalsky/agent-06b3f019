import { ipcMain, BrowserWindow, shell } from 'electron';
import { IMessageReader } from '../services/iMessageReader';
import { CookieReader } from '../services/cookieReader';
import { Uploader } from '../services/uploader';
import { BatchUploader } from '../services/batchUploader';
import { AuthService } from '../services/auth';
import { IMessageSender } from '../services/iMessageSender';
import { IMessageSync } from '../services/iMessageSync';
import { CookieSync } from '../services/cookieSync';
import { logIpc, logConsole, logConsoleError } from '../base/logger';

export function registerHandlers() {
  // Auth handlers
  ipcMain.handle('auth:check', async () => {
    logIpc('IN', 'auth:check');
    const session = await AuthService.getSession();
    logConsole('IPC Auth', 'check() called', { hasSession: !!session });
    logIpc('OUT', 'auth:check', { hasSession: !!session });
    return session;
  });

  ipcMain.handle('auth:save', (_, session) => {
    logIpc('IN', 'auth:save', { tokenPreview: session?.access_token?.substring(0, 20) + '...' });
    logConsole('IPC Auth', 'save() called', { expiresAt: session?.expires_at });
    AuthService.setSession(session);
    logConsole('IPC Auth', 'Session saved to store');

    // Trigger syncs after successful auth
    IMessageSync.sync().catch(err => logConsoleError('IPC Auth', 'Post-auth iMessage sync error', err));
    CookieSync.sync().catch(err => logConsoleError('IPC Auth', 'Post-auth cookie sync error', err));

    logIpc('OUT', 'auth:save', { success: true });
    return { success: true };
  });

  ipcMain.handle('auth:clear', () => {
    logIpc('IN', 'auth:clear');
    logConsole('IPC Auth', 'clear() called');
    AuthService.clearSession();
    logIpc('OUT', 'auth:clear', { success: true });
    return { success: true };
  });
  
  // iMessage handlers
  ipcMain.handle('imessage:checkAccess', () => {
    logIpc('IN', 'imessage:checkAccess');
    const hasAccess = IMessageReader.checkAccess();
    logIpc('OUT', 'imessage:checkAccess', { hasAccess });
    return hasAccess;
  });

  ipcMain.handle('imessage:startUpload', async (event) => {
    logIpc('IN', 'imessage:startUpload');
    logConsole('IPC', 'Starting iMessage upload process...');

    // Check access
    if (!IMessageReader.checkAccess()) {
      logConsoleError('IPC', 'No access to iMessage database');
      logIpc('OUT', 'imessage:startUpload', { success: false, message: 'Full Disk Access required' });
      return { success: false, message: 'Full Disk Access required' };
    }

    // Check auth
    const session = await AuthService.getSession();
    if (!session) {
      logConsoleError('IPC', 'Not authenticated');
      logIpc('OUT', 'imessage:startUpload', { success: false, message: 'Not authenticated' });
      return { success: false, message: 'Not authenticated' };
    }

    logConsole('IPC', 'Reading messages from database...');
    const messages = await IMessageReader.readMessages();
    logConsole('IPC', `Read ${messages.length} messages from database`);

    // Count unique contacts
    const contacts = new Set(messages.map((m: any) => m.contact_id));
    logConsole('IPC', `Sending ${messages.length} messages from ${contacts.size} contacts to backend`);

    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await BatchUploader.uploadInBatches(
      'imessage',
      messages,
      session.access_token,
      window
    );

    logConsole('IPC', 'Upload complete', result);
    logIpc('OUT', 'imessage:startUpload', result);
    return result;
  });

  ipcMain.handle('imessage:sendDirect', async (_, payload: { to: string; message: string }) => {
    logIpc('IN', 'imessage:sendDirect', { to: payload.to });
    try {
      await IMessageSender.send(payload);
      logIpc('OUT', 'imessage:sendDirect', { success: true });
      return { success: true };
    } catch (error: any) {
      logConsoleError('IPC', 'Failed to send direct iMessage', error);
      logIpc('OUT', 'imessage:sendDirect', { success: false, message: error?.message });
      return { success: false, message: error?.message || 'Failed to send iMessage' };
    }
  });
  
  // Cookie handlers
  ipcMain.handle('cookies:readChrome', async () => {
    logIpc('IN', 'cookies:readChrome');
    const cookies = await CookieReader.readCookies();
    logConsole('CookieReader', `Read ${cookies.length} cookies`);
    logIpc('OUT', 'cookies:readChrome', { count: cookies.length });
    return cookies;
  });

  ipcMain.handle('cookies:upload', async (event, data) => {
    logIpc('IN', 'cookies:upload', { count: data?.length });
    const session = await AuthService.getSession();
    if (!session) {
      logIpc('OUT', 'cookies:upload', { success: false, message: 'Not authenticated' });
      return { success: false, message: 'Not authenticated' };
    }

    const window = BrowserWindow.fromWebContents(event.sender);
    // Use batch uploader for cookies too
    const result = await BatchUploader.uploadInBatches('chrome_cookies', data, session.access_token, window);
    logIpc('OUT', 'cookies:upload', result);
    return result;
  });

  // System handlers
  ipcMain.handle('system:openFullDiskAccess', async () => {
    logIpc('IN', 'system:openFullDiskAccess');
    // Opens directly to Full Disk Access pane
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
    logIpc('OUT', 'system:openFullDiskAccess', { success: true });
    return { success: true };
  });
}

// Auto-register on import
registerHandlers();

// Initialize iMessage sync on startup
// Run initial sync (if already authenticated) and start background sync
IMessageSync.sync().catch(err => logConsoleError('Startup', 'Initial iMessage sync error', err));
IMessageSync.startBackgroundSync();

// Initialize cookie sync on startup
// Run initial sync (if already authenticated and connected) and start background sync
CookieSync.sync().catch(err => logConsoleError('Startup', 'Initial cookie sync error', err));
CookieSync.startBackgroundSync();

