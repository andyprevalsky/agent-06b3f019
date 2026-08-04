import { ipcMain, shell } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';
import { refreshCredentialExchangeActivityBridge } from '../domains/passkey-import/activity-bridge';
import { prepareCredentialExchangeHandoff } from '../domains/passkey-import/handoff-state';
import {
  getPasskeyAutoFillStatus,
  requestPasskeyAutoFillPermission,
} from '../domains/passkey-permission/service';
import { getErrorMessage } from '../../shared/utils/error';
import { logConsole, logConsoleError, logIpc } from '../base/logger';

const execAsync = promisify(exec);
const AUTO_FILL_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Passwords-Settings.extension';

async function openKeychainAccess(searchQuery?: string): Promise<{ success: boolean }> {
  try {
    if (searchQuery !== undefined && searchQuery !== '') {
      await execAsync(`osascript -e '
        tell application "Keychain Access" to activate
        delay 0.5
        tell application "System Events"
          tell process "Keychain Access"
            keystroke "f" using command down
            delay 0.2
            keystroke "${searchQuery}"
          end tell
        end tell
      '`);
    } else {
      await shell.openPath('/System/Applications/Utilities/Keychain Access.app');
    }
    return { success: true };
  } catch (error) {
    logConsoleError('System', 'Failed to open Keychain Access', error);
    try {
      await shell.openPath('/System/Applications/Utilities/Keychain Access.app');
      return { success: true };
    } catch {
      return { success: false };
    }
  }
}

export function registerSystemHandlers(): void {
  ipcMain.handle('system:openFullDiskAccess', async () => {
    logIpc('IN', 'system:openFullDiskAccess');
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
    );
    return { success: true };
  });

  ipcMain.handle('system:openKeychainAccess', async (_, searchQuery?: string) => {
    logIpc('IN', 'system:openKeychainAccess', { searchQuery });
    const result = await openKeychainAccess(searchQuery);
    logIpc('OUT', 'system:openKeychainAccess', result);
    return result;
  });

  ipcMain.handle('system:openPasswordsApp', async () => {
    logIpc('IN', 'system:openPasswordsApp', {});
    try {
      const handoffState = await prepareCredentialExchangeHandoff();
      logConsole('PasskeyImport', 'prepared credential exchange handoff state', handoffState);
      refreshCredentialExchangeActivityBridge('open-passwords-app');
      await shell.openPath('/System/Applications/Passwords.app');
      return { success: true };
    } catch (error) {
      logConsoleError('System', 'Failed to open Passwords app', error);
      return { success: false, message: getErrorMessage(error) };
    }
  });

  ipcMain.handle('system:openAutoFillSettings', async () => {
    logIpc('IN', 'system:openAutoFillSettings', {});
    try {
      const result = await requestPasskeyAutoFillPermission();
      if (!result.success && result.credentialExchangeEnabled === true) {
        await shell.openExternal(AUTO_FILL_SETTINGS_URL);
        return { ...result, success: true, enabled: false, openedSettings: true };
      }
      if (result.success && result.enabled !== true) {
        await shell.openExternal(AUTO_FILL_SETTINGS_URL);
        return { ...result, openedSettings: true };
      }
      return result;
    } catch (error) {
      logConsoleError('System', 'Failed to open AutoFill settings', error);
      return { success: false, message: getErrorMessage(error) };
    }
  });

  ipcMain.handle('system:checkAutoFillSettings', async () => {
    logIpc('IN', 'system:checkAutoFillSettings', {});
    try {
      return await getPasskeyAutoFillStatus();
    } catch (error) {
      logConsoleError('System', 'Failed to check AutoFill settings', error);
      return { success: false, message: getErrorMessage(error) };
    }
  });
}

export function registerShellHandlers(): void {
  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    logIpc('IN', 'shell:openExternal', { url });
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      logConsoleError('Shell', 'Failed to open external URL', error);
      return { success: false, message: getErrorMessage(error) || 'Failed to open URL' };
    }
  });
}
