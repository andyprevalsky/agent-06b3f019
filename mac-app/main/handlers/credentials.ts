import { BrowserWindow, ipcMain } from 'electron';
import { AtlasCredentialStore } from '../services/atlasCredentialStore';
import { ClaudeCredentialSync } from '../services/claudeCredentialSync';
import { GptCredentialSync } from '../services/gptCredentialSync';
import { getErrorMessage } from '../../shared/utils/error';
import { logConsoleError, logIpc } from '../base/logger';

export function registerAtlasHandlers(): void {
  ipcMain.handle('atlas:storePassword', (_, password: string) => {
    logIpc('IN', 'atlas:storePassword');
    return AtlasCredentialStore.storePassword(password);
  });
  ipcMain.handle('atlas:hasPassword', () => {
    logIpc('IN', 'atlas:hasPassword');
    return AtlasCredentialStore.hasPassword();
  });
  ipcMain.handle('atlas:clearPassword', () => {
    logIpc('IN', 'atlas:clearPassword');
    return AtlasCredentialStore.clearPassword();
  });
}

export function registerComputeCredentialHandlers(): void {
  ipcMain.handle('claude:hasCredentials', () => ClaudeCredentialSync.hasCredentials());
  ipcMain.handle('claude:syncCredentials', async (event) => {
    logIpc('IN', 'claude:syncCredentials');
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      return await ClaudeCredentialSync.syncCredentials(window);
    } catch (error) {
      logConsoleError('ClaudeCredentialSync', 'Sync failed', error);
      return { success: false, message: getErrorMessage(error) };
    }
  });
  ipcMain.handle('claude:setMockNoClaudeCode', (_event, mock: boolean) => {
    ClaudeCredentialSync.setMockNoClaudeCode(mock);
    return { success: true };
  });

  ipcMain.handle('gpt:hasCredentials', () => GptCredentialSync.hasCredentials());
  ipcMain.handle('gpt:syncCredentials', async (event) => {
    logIpc('IN', 'gpt:syncCredentials');
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      return await GptCredentialSync.syncCredentials(window);
    } catch (error) {
      logConsoleError('GptCredentialSync', 'Sync failed', error);
      return { success: false, message: getErrorMessage(error) };
    }
  });
}
