import { ipcMain, BrowserWindow, shell, globalShortcut } from 'electron';
import Store from 'electron-store';
import { exec } from 'child_process';
import { promisify } from 'util';
import { IMessageReader } from '../services/iMessageReader';
import { CookieReader } from '../services/cookieReader';
import { BrowserCookieReader, type BrowserType } from '../services/browserCookieReader';
import { FingerprintReader } from '../services/fingerprintReader';
import { Uploader } from '../services/uploader';
import { BatchUploader } from '../services/batchUploader';
import { AuthService } from '../services/auth';
import { IMessageSender } from '../services/iMessageSender';
import { IMessageSync } from '../services/iMessageSync';
import { CookieSync } from '../services/cookieSync';
import { BrowserStateSync } from '../services/browserStateSync';
import { AtlasCredentialStore } from '../services/atlasCredentialStore';
import { logIpc, logConsole, logConsoleError } from '../base/logger';
import type { ShortcutConfig, ReadBrowserCookiesConfig } from '../../shared/types/ipc';

const execAsync = promisify(exec);

// Stores for onboarding and shortcuts
interface OnboardingState {
  isComplete: boolean;
  lastAuthProvider: string | null;
}

const onboardingStore = new Store<OnboardingState>({
  name: 'onboarding',
  defaults: {
    isComplete: false,
    lastAuthProvider: null,
  },
});

const shortcutStore = new Store<{ quickLauncher?: ShortcutConfig }>({
  name: 'shortcuts',
  defaults: {},
});

// Helper to convert ShortcutConfig to Electron accelerator string
const configToAccelerator = (config: ShortcutConfig): string => {
  const modMap: Record<string, string> = {
    Meta: 'CommandOrControl',
    Alt: 'Alt',
    Control: 'Control',
    Shift: 'Shift',
  };

  const mods = config.modifiers.map(m => modMap[m] || m).join('+');
  return `${mods}+${config.key}`;
};

// Export for use in index.ts
export const getShortcutConfig = (): ShortcutConfig | null => {
  return shortcutStore.get('quickLauncher') ?? null;
};

export const getOnboardingComplete = (): boolean => {
  return onboardingStore.get('isComplete', false);
};

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

    // Trigger syncs after successful auth (all run in parallel)
    IMessageSync.sync().catch(err => logConsoleError('IPC Auth', 'Post-auth iMessage sync error', err));
    CookieSync.sync().catch(err => logConsoleError('IPC Auth', 'Post-auth cookie sync error', err));
    BrowserStateSync.sync().catch(err => logConsoleError('IPC Auth', 'Post-auth browser state sync error', err));

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
    const result = await BatchUploader.uploadInBatches('chrome', data, session.access_token, window);
    logIpc('OUT', 'cookies:upload', result);
    return result;
  });

  // Multi-browser cookie handlers
  ipcMain.handle('cookies:getInstalledBrowsers', async () => {
    logIpc('IN', 'cookies:getInstalledBrowsers');
    const browsers = BrowserCookieReader.getInstalledBrowsers();
    logConsole('BrowserCookieReader', `Found ${browsers.length} installed browsers`);
    logIpc('OUT', 'cookies:getInstalledBrowsers', { browsers: browsers.map(b => b.type) });
    return browsers;
  });

  ipcMain.handle('cookies:readBrowser', async (_, browser: BrowserType, config?: ReadBrowserCookiesConfig) => {
    logIpc('IN', 'cookies:readBrowser', { browser, hasPassword: !!config?.keychainPassword });
    try {
      const cookies = await BrowserCookieReader.readCookies(browser, config);
      logConsole('BrowserCookieReader', `Read ${cookies.length} ${browser} cookies`);
      logIpc('OUT', 'cookies:readBrowser', { browser, count: cookies.length });
      return cookies;
    } catch (error: any) {
      logConsoleError('BrowserCookieReader', `Failed to read ${browser} cookies`, error);
      logIpc('OUT', 'cookies:readBrowser', { browser, error: error.message });
      throw error;
    }
  });

  ipcMain.handle('cookies:uploadBrowser', async (event, browser: BrowserType, data) => {
    logIpc('IN', 'cookies:uploadBrowser', { browser, count: data?.length });
    const session = await AuthService.getSession();
    if (!session) {
      logIpc('OUT', 'cookies:uploadBrowser', { success: false, message: 'Not authenticated' });
      return { success: false, message: 'Not authenticated' };
    }

    const window = BrowserWindow.fromWebContents(event.sender);
    // Use browser-specific integration name (e.g., 'chrome', 'atlas')
    const integrationName = browser;
    const result = await BatchUploader.uploadInBatches(integrationName, data, session.access_token, window);
    logIpc('OUT', 'cookies:uploadBrowser', result);
    return result;
  });

  // Full browser sync handler (cookies + localStorage + IndexedDB + permissions + Cache Storage)
  ipcMain.handle('browser:sync', async (_, browser: BrowserType, config?: ReadBrowserCookiesConfig) => {
    logIpc('IN', 'browser:sync', { browser, hasPassword: !!config?.keychainPassword });
    try {
      const result = await BrowserStateSync.syncBrowser(browser, config);
      logConsole('BrowserStateSync', `syncBrowser(${browser}) complete`, result);
      logIpc('OUT', 'browser:sync', result);
      return result;
    } catch (error: any) {
      logConsoleError('BrowserStateSync', `syncBrowser(${browser}) failed`, error);
      logIpc('OUT', 'browser:sync', { success: false, error: error.message });
      return { success: false, message: error.message };
    }
  });

  // Password-only sync handler (just passwords, not full browser state)
  // For Atlas, pass keychainPassword in config
  ipcMain.handle('browser:syncPasswords', async (_, browser: BrowserType, config?: { keychainPassword?: string }) => {
    logIpc('IN', 'browser:syncPasswords', { browser, hasKeychainPassword: !!config?.keychainPassword });
    try {
      const result = await BrowserStateSync.syncBrowserPasswordsOnly(browser, config);
      logConsole('BrowserStateSync', `syncBrowserPasswordsOnly(${browser}) complete`, result);
      logIpc('OUT', 'browser:syncPasswords', result);
      return result;
    } catch (error: any) {
      logConsoleError('BrowserStateSync', `syncBrowserPasswordsOnly(${browser}) failed`, error);
      logIpc('OUT', 'browser:syncPasswords', { success: false, error: error.message });
      return { success: false, message: error.message };
    }
  });

  // Fingerprint handlers
  ipcMain.handle('fingerprint:collect', async () => {
    logIpc('IN', 'fingerprint:collect');
    try {
      const fingerprint = await FingerprintReader.collectFingerprint();
      logConsole('FingerprintReader', `Collected fingerprint: ${fingerprint ? 'success' : 'failed'}`);
      logIpc('OUT', 'fingerprint:collect', { success: !!fingerprint });
      return fingerprint;
    } catch (error: any) {
      logConsoleError('FingerprintReader', 'Error collecting fingerprint', error);
      logIpc('OUT', 'fingerprint:collect', { success: false, error: error?.message });
      return null;
    }
  });

  ipcMain.handle('fingerprint:upload', async (event, data) => {
    logIpc('IN', 'fingerprint:upload');
    const session = await AuthService.getSession();
    if (!session) {
      logIpc('OUT', 'fingerprint:upload', { success: false, message: 'Not authenticated' });
      return { success: false, message: 'Not authenticated' };
    }

    const window = BrowserWindow.fromWebContents(event.sender);
    // Use batch uploader for fingerprint
    const result = await BatchUploader.uploadInBatches('browser_fingerprint', data, session.access_token, window);
    logIpc('OUT', 'fingerprint:upload', result);
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

  ipcMain.handle('system:openKeychainAccess', async (_, searchQuery?: string) => {
    logIpc('IN', 'system:openKeychainAccess', { searchQuery });
    try {
      if (searchQuery) {
        // Open Keychain Access and populate search field using AppleScript
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
        // Just open Keychain Access
        await shell.openPath('/System/Applications/Utilities/Keychain Access.app');
      }
      logIpc('OUT', 'system:openKeychainAccess', { success: true });
      return { success: true };
    } catch (error: any) {
      logConsoleError('System', 'Failed to open Keychain Access', error);
      // Fall back to just opening Keychain Access without search
      try {
        await shell.openPath('/System/Applications/Utilities/Keychain Access.app');
        logIpc('OUT', 'system:openKeychainAccess', { success: true, fallback: true });
        return { success: true };
      } catch {
        logIpc('OUT', 'system:openKeychainAccess', { success: false });
        return { success: false };
      }
    }
  });

  ipcMain.handle('system:openPasswordsApp', async () => {
    logIpc('IN', 'system:openPasswordsApp', {});
    try {
      await shell.openPath('/System/Applications/Passwords.app');
      logIpc('OUT', 'system:openPasswordsApp', { success: true });
      return { success: true };
    } catch (error: any) {
      logConsoleError('System', 'Failed to open Passwords app', error);
      logIpc('OUT', 'system:openPasswordsApp', { success: false });
      return { success: false };
    }
  });

  // Shell handlers
  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    logIpc('IN', 'shell:openExternal', { url });
    try {
      await shell.openExternal(url);
      logIpc('OUT', 'shell:openExternal', { success: true });
      return { success: true };
    } catch (error: any) {
      logConsoleError('Shell', 'Failed to open external URL', error);
      logIpc('OUT', 'shell:openExternal', { success: false, message: error?.message });
      return { success: false, message: error?.message || 'Failed to open URL' };
    }
  });

  // Shortcut handlers
  ipcMain.handle('shortcut:get', () => {
    logIpc('IN', 'shortcut:get');
    const config = shortcutStore.get('quickLauncher') ?? null;
    logIpc('OUT', 'shortcut:get', { config });
    return config;
  });

  ipcMain.handle('shortcut:set', (_, config: ShortcutConfig) => {
    logIpc('IN', 'shortcut:set', { config });
    shortcutStore.set('quickLauncher', config);
    logConsole('Shortcut', 'Saved new shortcut config', { config });
    logIpc('OUT', 'shortcut:set', { success: true });
    return { success: true };
  });

  ipcMain.handle('shortcut:validate', (_, config: ShortcutConfig) => {
    logIpc('IN', 'shortcut:validate', { config });
    try {
      const accelerator = configToAccelerator(config);
      // Try registering temporarily to check availability
      const available = globalShortcut.register(accelerator, () => {});
      if (available) {
        globalShortcut.unregister(accelerator);
      }
      logIpc('OUT', 'shortcut:validate', { available });
      return { available };
    } catch (err) {
      logConsoleError('Shortcut', 'Validation error', err);
      logIpc('OUT', 'shortcut:validate', { available: false });
      return { available: false };
    }
  });

  // Onboarding handlers
  ipcMain.handle('onboarding:isComplete', () => {
    logIpc('IN', 'onboarding:isComplete');
    const isComplete = onboardingStore.get('isComplete', false);
    logIpc('OUT', 'onboarding:isComplete', { isComplete });
    return isComplete;
  });

  ipcMain.handle('onboarding:setComplete', (_, complete: boolean) => {
    logIpc('IN', 'onboarding:setComplete', { complete });
    onboardingStore.set('isComplete', complete);
    logConsole('Onboarding', 'Set complete', { complete });
    logIpc('OUT', 'onboarding:setComplete', { success: true });
    return { success: true };
  });

  ipcMain.handle('onboarding:getLastAuthProvider', () => {
    logIpc('IN', 'onboarding:getLastAuthProvider');
    const provider = onboardingStore.get('lastAuthProvider', null);
    logIpc('OUT', 'onboarding:getLastAuthProvider', { provider });
    return provider;
  });

  ipcMain.handle('onboarding:setLastAuthProvider', (_, provider: string) => {
    logIpc('IN', 'onboarding:setLastAuthProvider', { provider });
    onboardingStore.set('lastAuthProvider', provider);
    logConsole('Onboarding', 'Set last auth provider', { provider });
    logIpc('OUT', 'onboarding:setLastAuthProvider', { success: true });
    return { success: true };
  });

  // Atlas credential handlers
  ipcMain.handle('atlas:storePassword', (_, password: string) => {
    logIpc('IN', 'atlas:storePassword');
    const result = AtlasCredentialStore.storePassword(password);
    logIpc('OUT', 'atlas:storePassword', { success: result.success });
    return result;
  });

  ipcMain.handle('atlas:hasPassword', () => {
    logIpc('IN', 'atlas:hasPassword');
    const hasPassword = AtlasCredentialStore.hasPassword();
    logIpc('OUT', 'atlas:hasPassword', { hasPassword });
    return hasPassword;
  });

  ipcMain.handle('atlas:clearPassword', () => {
    logIpc('IN', 'atlas:clearPassword');
    const result = AtlasCredentialStore.clearPassword();
    logIpc('OUT', 'atlas:clearPassword', { success: result.success });
    return result;
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

// Initialize browser state sync (localStorage) on startup
BrowserStateSync.sync().catch(err => logConsoleError('Startup', 'Initial browser state sync error', err));
BrowserStateSync.startBackgroundSync();

