import { ipcMain, BrowserWindow, shell } from 'electron';
import { IMessageReader } from '../services/iMessageReader';
import { CookieReader } from '../services/cookieReader';
import { Uploader } from '../services/uploader';
import { BatchUploader } from '../services/batchUploader';
import { AuthService } from '../services/auth';
import { IMessageSender } from '../services/iMessageSender';

export function registerHandlers() {
  // Auth handlers
  ipcMain.handle('auth:check', () => {
    const session = AuthService.getSession();
    console.log('[IPC Auth] check() called, has session:', !!session);
    return session;
  });
  
  ipcMain.handle('auth:save', (_, session) => {
    console.log('[IPC Auth] 💾 save() called');
    console.log('[IPC Auth] Token preview:', session?.access_token?.substring(0, 20) + '...');
    console.log('[IPC Auth] Expires at:', session?.expires_at, session?.expires_at ? new Date(session.expires_at * 1000) : 'N/A');
    AuthService.setSession(session);
    console.log('[IPC Auth] ✅ Session saved to store');
    return { success: true };
  });
  
  ipcMain.handle('auth:clear', () => {
    console.log('[IPC Auth] 🗑️ clear() called');
    AuthService.clearSession();
    return { success: true };
  });
  
  // iMessage handlers
  ipcMain.handle('imessage:checkAccess', () => {
    return IMessageReader.checkAccess();
  });
  
  ipcMain.handle('imessage:startUpload', async (event) => {
    console.log('[IPC] Starting iMessage upload process...');
    
    // Check access
    if (!IMessageReader.checkAccess()) {
      console.error('[IPC] No access to iMessage database');
      return { success: false, message: 'Full Disk Access required' };
    }
    
    // Check auth
    const session = AuthService.getSession();
    if (!session) {
      console.error('[IPC] ❌ Not authenticated');
      return { success: false, message: 'Not authenticated' };
    }
    
      console.log('[IPC] Reading messages from database...');
      const messages = await IMessageReader.readMessages();
      console.log(`[IPC] ✅ Read ${messages.length} messages from database`);
    
    // Count unique contacts
    const contacts = new Set(messages.map((m: any) => m.contact_id));
    console.log(`[IPC] 📊 Sending ${messages.length} messages from ${contacts.size} contacts to backend for processing`);
    
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await BatchUploader.uploadInBatches(
      'imessage',
      messages,
      session.access_token,
      window
    );
    
    console.log('[IPC] 🏁 Upload complete:', result);
    return result;
  });

  ipcMain.handle('imessage:sendDirect', async (_, payload: { to: string; message: string }) => {
    try {
      await IMessageSender.send(payload);
      return { success: true };
    } catch (error: any) {
      console.error('[IPC] Failed to send direct iMessage:', error);
      return { success: false, message: error?.message || 'Failed to send iMessage' };
    }
  });
  
  // Cookie handlers
  ipcMain.handle('cookies:readChrome', async () => {
    return await CookieReader.readCookies();
  });
  
  ipcMain.handle('cookies:upload', async (event, data) => {
    const session = AuthService.getSession();
    if (!session) {
      return { success: false, message: 'Not authenticated' };
    }
    
    const window = BrowserWindow.fromWebContents(event.sender);
    // Use batch uploader for cookies too
    return await BatchUploader.uploadInBatches('chrome_cookies', data, session.access_token, window);
  });
  
  // System handlers
  ipcMain.handle('system:openFullDiskAccess', async () => {
    // Opens directly to Full Disk Access pane
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
    return { success: true };
  });
}

// Auto-register on import
registerHandlers();

