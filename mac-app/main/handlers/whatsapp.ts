import { BrowserWindow, ipcMain } from 'electron';
import { WhatsAppSync } from '../services/messaging/platforms/whatsapp/WhatsAppSync';
import { getErrorMessage } from '../../shared/utils/error';
import { logConsoleError, logIpc } from '../base/logger';
import { getLocalMachineDataSession } from './machine-session';

export function registerWhatsAppHandlers(): void {
  ipcMain.handle('whatsapp:hasCredentials', () => WhatsAppSync.hasCredentials());
  ipcMain.handle('whatsapp:getLinkedPhoneNumber', () => WhatsAppSync.getLinkedPhoneNumber());
  ipcMain.handle('whatsapp:isConnected', () => WhatsAppSync.isConnected());

  ipcMain.handle('whatsapp:connect', async (event) => {
    logIpc('IN', 'whatsapp:connect');
    try {
      const { session, error } = await getLocalMachineDataSession();
      if (!session) return { success: false, error };
      const window = BrowserWindow.fromWebContents(event.sender);
      // Backend registration is owned by WhatsAppSync.connect() so every
      // connect path (IPC, SyncManager auto-connect) gets it.
      await WhatsAppSync.connect({
        onQRCode: (qr: string) => window?.webContents.send('whatsapp:qrCode', qr),
      });
      return { success: true };
    } catch (error) {
      logConsoleError('WhatsApp', 'Connect failed', error);
      return { success: false, error: getErrorMessage(error) || 'Connection failed' };
    }
  });

  ipcMain.handle('whatsapp:disconnect', async () => {
    try {
      await WhatsAppSync.disconnect();
      return { success: true };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) || 'Disconnect failed' };
    }
  });

  ipcMain.handle('whatsapp:logout', async () => {
    try {
      await WhatsAppSync.logout();
      return { success: true };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) || 'Logout failed' };
    }
  });
}
