import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { WhatsAppSync } from '../services/messaging/platforms/whatsapp/WhatsAppSync';
import { getErrorMessage } from '../../shared/utils/error';
import { logConsoleError, logIpc } from '../base/logger';
import { getLocalMachineDataSession } from './machine-session';

type Outcome = { success: boolean; error?: string | null };

/** An account id from the renderer: a non-empty string, else "all / any account". */
function accountArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Dial WhatsApp (connect every linked account, or pair one more) only with a
 * machine session: pairing uploads history, so without one every later flush
 * would be dropped after the user already scanned the QR code.
 */
async function dial(
  event: IpcMainInvokeEvent,
  channel: string,
  run: (onQRCode: (qr: string) => void) => Promise<void>
): Promise<Outcome> {
  logIpc('IN', channel);
  try {
    const { session, error } = await getLocalMachineDataSession();
    if (!session) return { success: false, error };
    const window = BrowserWindow.fromWebContents(event.sender);
    // Backend registration is owned by WhatsAppSync so every connect path
    // (IPC, SyncManager auto-connect) gets it.
    await run((qr: string) => window?.webContents.send('whatsapp:qrCode', qr));
    return { success: true };
  } catch (error) {
    logConsoleError('WhatsApp', 'Connect failed', error);
    return { success: false, error: getErrorMessage(error) || 'Connection failed' };
  }
}

export function registerWhatsAppHandlers(): void {
  ipcMain.handle('whatsapp:hasCredentials', () => WhatsAppSync.hasCredentials());
  ipcMain.handle('whatsapp:getLinkedPhoneNumber', () => WhatsAppSync.getLinkedPhoneNumber());
  ipcMain.handle('whatsapp:isConnected', (_event, accountId?: unknown) =>
    WhatsAppSync.isConnected(accountArg(accountId))
  );
  ipcMain.handle('whatsapp:listAccounts', () => WhatsAppSync.listAccounts());

  ipcMain.handle('whatsapp:connect', (event) =>
    dial(event, 'whatsapp:connect', (onQRCode) => WhatsAppSync.connect({ onQRCode }))
  );
  ipcMain.handle('whatsapp:addAccount', (event) =>
    dial(event, 'whatsapp:addAccount', (onQRCode) => WhatsAppSync.addAccount({ onQRCode }))
  );

  ipcMain.handle('whatsapp:disconnect', async () => {
    try {
      await WhatsAppSync.disconnect();
      return { success: true };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) || 'Disconnect failed' };
    }
  });

  /** Without an account id every account is logged out (pre-multi-account behavior). */
  ipcMain.handle('whatsapp:logout', async (_event, accountId?: unknown) => {
    try {
      await WhatsAppSync.logout(accountArg(accountId));
      return { success: true };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) || 'Logout failed' };
    }
  });
}
