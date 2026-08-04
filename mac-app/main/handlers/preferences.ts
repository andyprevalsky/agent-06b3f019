import { globalShortcut, ipcMain } from 'electron';
import type { ShortcutConfig } from '../../shared/types/ipc';
import { logConsole, logConsoleError, logIpc } from '../base/logger';
import {
  configToAccelerator,
  getLastAuthProvider,
  getOnboardingComplete,
  getShortcutConfig,
  setLastAuthProvider,
  setOnboardingComplete,
  setShortcutConfig,
} from './state';

export function registerShortcutHandlers(): void {
  ipcMain.handle('shortcut:get', () => {
    logIpc('IN', 'shortcut:get');
    return getShortcutConfig();
  });

  ipcMain.handle('shortcut:set', (_, config: ShortcutConfig) => {
    logIpc('IN', 'shortcut:set', { config });
    setShortcutConfig(config);
    logConsole('Shortcut', 'Saved new shortcut config', { config });
    return { success: true };
  });

  ipcMain.handle('shortcut:validate', (_, config: ShortcutConfig) => {
    logIpc('IN', 'shortcut:validate', { config });
    try {
      const accelerator = configToAccelerator(config);
      const available = globalShortcut.register(accelerator, () => {});
      if (available) globalShortcut.unregister(accelerator);
      return { available };
    } catch (error) {
      logConsoleError('Shortcut', 'Validation error', error);
      return { available: false };
    }
  });
}

export function registerOnboardingHandlers(): void {
  ipcMain.handle('onboarding:isComplete', () => {
    logIpc('IN', 'onboarding:isComplete');
    return getOnboardingComplete();
  });

  ipcMain.handle('onboarding:setComplete', (_, complete: boolean) => {
    logIpc('IN', 'onboarding:setComplete', { complete });
    setOnboardingComplete(complete);
    return { success: true };
  });

  ipcMain.handle('onboarding:getLastAuthProvider', () => {
    logIpc('IN', 'onboarding:getLastAuthProvider');
    return getLastAuthProvider();
  });

  ipcMain.handle('onboarding:setLastAuthProvider', (_, provider: string) => {
    logIpc('IN', 'onboarding:setLastAuthProvider', { provider });
    setLastAuthProvider(provider);
    return { success: true };
  });
}
