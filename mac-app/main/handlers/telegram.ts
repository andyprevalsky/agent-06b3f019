import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { TelegramSync } from '../services/messaging/platforms/telegram/TelegramSync';
import { getErrorMessage } from '../../shared/utils/error';
import { logConsoleError, logIpc } from '../base/logger';
import { getLocalMachineDataSession } from './machine-session';

/** Register every connected account (one backend row per Telegram user id), then sync. */
async function registerTelegramIntegration(): Promise<void> {
  const { session } = await getLocalMachineDataSession();
  if (!session) return;
  const registered = await TelegramSync.registerConnectedAccounts();
  if (registered === 0) {
    logConsoleError('Telegram', 'Failed to register integration', 'no account registered');
    return;
  }
  void TelegramSync.syncHistorical().catch((error) =>
    logConsoleError('Telegram', 'Historical sync error', error)
  );
}

function bindTelegramAuthEvents(
  event: IpcMainInvokeEvent,
  client: NonNullable<ReturnType<typeof TelegramSync.getClient>>
): void {
  const window = BrowserWindow.fromWebContents(event.sender);
  client.on('auth:needCode', () => window?.webContents.send('telegram:needCode'));
  client.on('auth:needPassword', () => window?.webContents.send('telegram:needPassword'));
  client.on('auth:complete', () => {
    window?.webContents.send('telegram:authComplete');
    void registerTelegramIntegration().catch((error) =>
      logConsoleError('Telegram', 'Error registering integration', error)
    );
  });
  client.on('auth:error', (message: string) => {
    logConsoleError('Telegram', 'Auth error', message);
    window?.webContents.send('telegram:authError', message);
  });
}

export function registerTelegramStatusHandlers(): void {
  ipcMain.handle('telegram:hasSession', () => TelegramSync.hasSession());
  ipcMain.handle('telegram:hasApiCredentials', () => TelegramSync.hasApiCredentials());
  ipcMain.handle('telegram:isConnected', () => TelegramSync.isConnected());
  ipcMain.handle('telegram:listAccounts', () => TelegramSync.listAccounts());

  ipcMain.handle(
    'telegram:syncHistorical',
    async (_, messagesPerDialog?: number, accountId?: string) => {
      try {
        const { session, error } = await getLocalMachineDataSession();
        if (!session) return { success: false, error };
        const count = await TelegramSync.syncHistorical(messagesPerDialog, accountId);
        return { success: true, count };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) || 'Historical sync failed' };
      }
    }
  );
}

export function registerTelegramConnectionHandlers(): void {
  ipcMain.handle('telegram:connectWithExistingSession', async () => {
    logIpc('IN', 'telegram:connectWithExistingSession');
    try {
      const { session, error } = await getLocalMachineDataSession();
      if (!session) return { success: false, error };
      const success = await TelegramSync.connectWithExistingSession();
      if (success) {
        await registerTelegramIntegration().catch((registrationError) =>
          logConsoleError('Telegram', 'Error registering integration', registrationError)
        );
      }
      return { success };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) || 'Connection failed' };
    }
  });

  ipcMain.handle('telegram:disconnect', async () => {
    try {
      await TelegramSync.disconnect();
      return { success: true };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) || 'Disconnect failed' };
    }
  });

  ipcMain.handle('telegram:logout', async (_, accountId?: string) => {
    try {
      await TelegramSync.logout(typeof accountId === 'string' ? accountId : undefined);
      return { success: true };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) || 'Logout failed' };
    }
  });
}

export function registerTelegramAuthHandlers(): void {
  ipcMain.handle('telegram:startAuth', async (event, phoneNumber: string) => {
    logIpc('IN', 'telegram:startAuth', { phoneNumber: phoneNumber.slice(0, 4) + '***' });
    try {
      const { session, error } = await getLocalMachineDataSession();
      if (!session) return { success: false, error };
      const result = await TelegramSync.startAuth(phoneNumber);
      const client = TelegramSync.getClient();
      if (result.success && client) bindTelegramAuthEvents(event, client);
      return result;
    } catch (error) {
      return { success: false, error: getErrorMessage(error) || 'Failed to start auth' };
    }
  });

  ipcMain.handle('telegram:submitCode', (_, code: string) => {
    try {
      TelegramSync.submitCode(code);
      return { success: true };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) || 'Failed to submit code' };
    }
  });

  ipcMain.handle('telegram:submitPassword', (_, password: string) => {
    try {
      TelegramSync.submitPassword(password);
      return { success: true };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) || 'Failed to submit password' };
    }
  });

  ipcMain.handle('telegram:cancelAuth', () => {
    try {
      TelegramSync.cancelAuth();
      return { success: true };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) || 'Cancel auth failed' };
    }
  });
}
