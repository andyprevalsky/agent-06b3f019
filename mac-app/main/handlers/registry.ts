/* eslint-disable max-lines, max-lines-per-function -- TODO: split into per-domain handler modules; tracked for a follow-up refactor. */
import { ipcMain, BrowserWindow, shell, globalShortcut } from 'electron';
import Store from 'electron-store';
import { exec } from 'child_process';
import { promisify } from 'util';
import { IMessageReader } from '../services/iMessageReader';
import { CookieReader } from '../services/cookieReader';
import { BrowserCookieReader, type BrowserType } from '../services/browserCookieReader';
import { FingerprintReader } from '../services/fingerprintReader';
import { BatchUploader } from '../services/batchUploader';
import { AuthService } from '../services/auth';
import { IMessageSender } from '../services/iMessageSender';
import { IMessageSync } from '../services/iMessageSync';
import { CookieSync } from '../services/cookieSync';
import { BrowserStateSync } from '../services/browserStateSync';
import { AtlasCredentialStore } from '../services/atlasCredentialStore';
import { ClaudeCredentialSync } from '../services/claudeCredentialSync';
import { GptCredentialSync } from '../services/gptCredentialSync';
import { WhatsAppSync } from '../services/messaging/platforms/whatsapp/WhatsAppSync';
import { TelegramSync } from '../services/messaging/platforms/telegram/TelegramSync';
import { SyncManager } from '../services/sync/SyncManager';
import { IntegrationCache } from '../services/sync/IntegrationCache';
import { enrollPasskey } from '../domains/passkey-enroll/service';
import { refreshCredentialExchangeActivityBridge } from '../domains/passkey-import/activity-bridge';
import { prepareCredentialExchangeHandoff } from '../domains/passkey-import/handoff-state';
import { importPasskeysFromToken } from '../domains/passkey-import/service';
import {
  getPasskeyAutoFillStatus,
  requestPasskeyAutoFillPermission,
} from '../domains/passkey-permission/service';
import { getErrorMessage } from '../../shared/utils/error';
import { logIpc, logConsole, logConsoleError } from '../base/logger';
import { config } from '../base/config';
import type { ShortcutConfig, ReadBrowserCookiesConfig } from '../../shared/types/ipc';

const execAsync = promisify(exec);

// Stores for onboarding and shortcuts
interface OnboardingState {
  isComplete: boolean;
  lastAuthProvider: string | null;
}

const onboardingStore = new Store<OnboardingState>({
  name: 'onboarding',
  clearInvalidConfig: true,
  defaults: {
    isComplete: false,
    lastAuthProvider: null,
  },
});

const shortcutStore = new Store<{ quickLauncher?: ShortcutConfig }>({
  name: 'shortcuts',
  clearInvalidConfig: true,
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

  const mods = config.modifiers.map((m) => modMap[m] || m).join('+');
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
    IMessageSync.sync().catch((err) =>
      logConsoleError('IPC Auth', 'Post-auth iMessage sync error', err)
    );
    CookieSync.sync().catch((err) =>
      logConsoleError('IPC Auth', 'Post-auth cookie sync error', err)
    );
    BrowserStateSync.sync().catch((err) =>
      logConsoleError('IPC Auth', 'Post-auth browser state sync error', err)
    );

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

  // Passkey enroll: mint an exportable agent passkey via a CDP virtual
  // authenticator in an Electron window, then upload it to the backend.
  ipcMain.handle('passkeys:enroll', async (_, params: { url: string; rpMatch?: string }) => {
    logIpc('IN', 'passkeys:enroll', { url: params?.url });
    try {
      const session = await AuthService.getSession();
      if (!session) {
        logIpc('OUT', 'passkeys:enroll', { success: false, message: 'Not authenticated' });
        return { success: false, message: 'Not authenticated' };
      }
      const result = await enrollPasskey(params, session.access_token);
      logIpc('OUT', 'passkeys:enroll', result);
      return result;
    } catch (error) {
      logConsoleError('IPC', getErrorMessage(error));
      return { success: false, message: getErrorMessage(error) };
    }
  });

  // Apple Credential Exchange import: given an OS-issued import token, run the
  // native helper and upload the user's real passkeys.
  ipcMain.handle('passkeys:importFromToken', async (_, token: string) => {
    logIpc('IN', 'passkeys:importFromToken', { tokenPreview: String(token).slice(0, 8) });
    try {
      const session = await AuthService.getSession();
      if (!session) return { success: false, message: 'Not authenticated' };
      const result = await importPasskeysFromToken(token, session.access_token);
      logIpc('OUT', 'passkeys:importFromToken', result);
      return result;
    } catch (error) {
      logConsoleError('IPC', getErrorMessage(error));
      return { success: false, message: getErrorMessage(error) };
    }
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
      logIpc('OUT', 'imessage:startUpload', {
        success: false,
        message: 'Full Disk Access required',
      });
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
    const contacts = new Set(messages.map((m) => m.contact_id));
    logConsole(
      'IPC',
      `Sending ${messages.length} messages from ${contacts.size} contacts to backend`
    );

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
    } catch (error) {
      logConsoleError('IPC', 'Failed to send direct iMessage', error);
      logIpc('OUT', 'imessage:sendDirect', { success: false, message: getErrorMessage(error) });
      return { success: false, message: getErrorMessage(error) || 'Failed to send iMessage' };
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
    const result = await BatchUploader.uploadInBatches(
      'chrome',
      data,
      session.access_token,
      window
    );
    logIpc('OUT', 'cookies:upload', result);
    return result;
  });

  // Multi-browser cookie handlers
  ipcMain.handle('cookies:getInstalledBrowsers', async () => {
    logIpc('IN', 'cookies:getInstalledBrowsers');
    const browsers = BrowserCookieReader.getInstalledBrowsers();
    logConsole('BrowserCookieReader', `Found ${browsers.length} installed browsers`);
    logIpc('OUT', 'cookies:getInstalledBrowsers', { browsers: browsers.map((b) => b.type) });
    return browsers;
  });

  ipcMain.handle(
    'cookies:readBrowser',
    async (_, browser: BrowserType, config?: ReadBrowserCookiesConfig) => {
      logIpc('IN', 'cookies:readBrowser', {
        browser,
        hasPassword: Boolean(config?.keychainPassword),
      });
      try {
        const cookies = await BrowserCookieReader.readCookies(browser, config);
        logConsole('BrowserCookieReader', `Read ${cookies.length} ${browser} cookies`);
        logIpc('OUT', 'cookies:readBrowser', { browser, count: cookies.length });
        return cookies;
      } catch (error) {
        logConsoleError('BrowserCookieReader', `Failed to read ${browser} cookies`, error);
        logIpc('OUT', 'cookies:readBrowser', { browser, error: getErrorMessage(error) });
        throw error;
      }
    }
  );

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
    const result = await BatchUploader.uploadInBatches(
      integrationName,
      data,
      session.access_token,
      window
    );
    logIpc('OUT', 'cookies:uploadBrowser', result);
    return result;
  });

  // Full browser sync handler (cookies + localStorage + IndexedDB + permissions + Cache Storage)
  ipcMain.handle(
    'browser:sync',
    async (_, browser: BrowserType, config?: ReadBrowserCookiesConfig) => {
      logIpc('IN', 'browser:sync', { browser, hasPassword: Boolean(config?.keychainPassword) });
      try {
        const result = await BrowserStateSync.syncBrowser(browser, config);
        logConsole('BrowserStateSync', `syncBrowser(${browser}) complete`, result);
        logIpc('OUT', 'browser:sync', result);
        return result;
      } catch (error) {
        logConsoleError('BrowserStateSync', `syncBrowser(${browser}) failed`, error);
        logIpc('OUT', 'browser:sync', { success: false, error: getErrorMessage(error) });
        return { success: false, message: getErrorMessage(error) };
      }
    }
  );

  // Password-only sync handler (just passwords, not full browser state)
  // For Atlas, pass keychainPassword in config
  ipcMain.handle(
    'browser:syncPasswords',
    async (_, browser: BrowserType, config?: { keychainPassword?: string }) => {
      logIpc('IN', 'browser:syncPasswords', {
        browser,
        hasKeychainPassword: Boolean(config?.keychainPassword),
      });
      try {
        const result = await BrowserStateSync.syncBrowserPasswordsOnly(browser, config);
        logConsole('BrowserStateSync', `syncBrowserPasswordsOnly(${browser}) complete`, result);
        logIpc('OUT', 'browser:syncPasswords', result);
        return result;
      } catch (error) {
        logConsoleError('BrowserStateSync', `syncBrowserPasswordsOnly(${browser}) failed`, error);
        logIpc('OUT', 'browser:syncPasswords', { success: false, error: getErrorMessage(error) });
        return { success: false, message: getErrorMessage(error) };
      }
    }
  );

  // Fingerprint handlers
  ipcMain.handle('fingerprint:collect', async () => {
    logIpc('IN', 'fingerprint:collect');
    try {
      const fingerprint = await FingerprintReader.collectFingerprint();
      logConsole(
        'FingerprintReader',
        `Collected fingerprint: ${fingerprint ? 'success' : 'failed'}`
      );
      logIpc('OUT', 'fingerprint:collect', { success: !!fingerprint });
      return fingerprint;
    } catch (error) {
      logConsoleError('FingerprintReader', 'Error collecting fingerprint', error);
      logIpc('OUT', 'fingerprint:collect', { success: false, error: getErrorMessage(error) });
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
    const result = await BatchUploader.uploadInBatches(
      'browser_fingerprint',
      data,
      session.access_token,
      window
    );
    logIpc('OUT', 'fingerprint:upload', result);
    return result;
  });

  // System handlers
  ipcMain.handle('system:openFullDiskAccess', async () => {
    logIpc('IN', 'system:openFullDiskAccess');
    // Opens directly to Full Disk Access pane
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
    );
    logIpc('OUT', 'system:openFullDiskAccess', { success: true });
    return { success: true };
  });

  ipcMain.handle('system:openKeychainAccess', async (_, searchQuery?: string) => {
    logIpc('IN', 'system:openKeychainAccess', { searchQuery });
    try {
      if (searchQuery !== undefined && searchQuery !== '') {
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
    } catch (error) {
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
      const handoffState = await prepareCredentialExchangeHandoff();
      logConsole('PasskeyImport', 'prepared credential exchange handoff state', handoffState);
      refreshCredentialExchangeActivityBridge('open-passwords-app');
      await shell.openPath('/System/Applications/Passwords.app');
      logIpc('OUT', 'system:openPasswordsApp', { success: true });
      return { success: true };
    } catch (error) {
      logConsoleError('System', 'Failed to open Passwords app', error);
      const result = { success: false, message: getErrorMessage(error) };
      logIpc('OUT', 'system:openPasswordsApp', result);
      return result;
    }
  });

  ipcMain.handle('system:openAutoFillSettings', async () => {
    logIpc('IN', 'system:openAutoFillSettings', {});
    try {
      const result = await requestPasskeyAutoFillPermission();
      if (!result.success && result.credentialExchangeEnabled === true) {
        await shell.openExternal(
          'x-apple.systempreferences:com.apple.Passwords-Settings.extension'
        );
        const fallbackResult = { ...result, success: true, enabled: false, openedSettings: true };
        logIpc('OUT', 'system:openAutoFillSettings', fallbackResult);
        return fallbackResult;
      }
      if (result.success && result.enabled !== true) {
        await shell.openExternal(
          'x-apple.systempreferences:com.apple.Passwords-Settings.extension'
        );
        const fallbackResult = { ...result, openedSettings: true };
        logIpc('OUT', 'system:openAutoFillSettings', fallbackResult);
        return fallbackResult;
      }
      logIpc('OUT', 'system:openAutoFillSettings', result);
      return result;
    } catch (error) {
      logConsoleError('System', 'Failed to open AutoFill & Passwords settings', error);
      const result = { success: false, message: getErrorMessage(error) };
      logIpc('OUT', 'system:openAutoFillSettings', result);
      return result;
    }
  });

  ipcMain.handle('system:checkAutoFillSettings', async () => {
    logIpc('IN', 'system:checkAutoFillSettings', {});
    try {
      const result = await getPasskeyAutoFillStatus();
      logIpc('OUT', 'system:checkAutoFillSettings', result);
      return result;
    } catch (error) {
      logConsoleError('System', 'Failed to check AutoFill & Passwords settings', error);
      const result = { success: false, message: getErrorMessage(error) };
      logIpc('OUT', 'system:checkAutoFillSettings', result);
      return result;
    }
  });

  // Shell handlers
  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    logIpc('IN', 'shell:openExternal', { url });
    try {
      await shell.openExternal(url);
      logIpc('OUT', 'shell:openExternal', { success: true });
      return { success: true };
    } catch (error) {
      logConsoleError('Shell', 'Failed to open external URL', error);
      logIpc('OUT', 'shell:openExternal', { success: false, message: getErrorMessage(error) });
      return { success: false, message: getErrorMessage(error) || 'Failed to open URL' };
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

  // Claude Code credential handlers
  ipcMain.handle('claude:hasCredentials', () => {
    logIpc('IN', 'claude:hasCredentials');
    const hasCredentials = ClaudeCredentialSync.hasCredentials();
    logIpc('OUT', 'claude:hasCredentials', { hasCredentials });
    return hasCredentials;
  });

  ipcMain.handle('claude:syncCredentials', async (event) => {
    logIpc('IN', 'claude:syncCredentials');
    const window = BrowserWindow.fromWebContents(event.sender);
    try {
      const result = await ClaudeCredentialSync.syncCredentials(window);
      logIpc('OUT', 'claude:syncCredentials', result);
      return result;
    } catch (error) {
      logConsoleError('ClaudeCredentialSync', 'Sync failed', error);
      logIpc('OUT', 'claude:syncCredentials', { success: false, message: getErrorMessage(error) });
      return { success: false, message: getErrorMessage(error) };
    }
  });

  ipcMain.handle('claude:setMockNoClaudeCode', (_event, mock: boolean) => {
    logIpc('IN', 'claude:setMockNoClaudeCode', { mock });
    ClaudeCredentialSync.setMockNoClaudeCode(mock);
    logIpc('OUT', 'claude:setMockNoClaudeCode', { success: true });
    return { success: true };
  });

  ipcMain.handle('gpt:hasCredentials', () => {
    logIpc('IN', 'gpt:hasCredentials');
    const hasCredentials = GptCredentialSync.hasCredentials();
    logIpc('OUT', 'gpt:hasCredentials', { hasCredentials });
    return hasCredentials;
  });

  ipcMain.handle('gpt:syncCredentials', async (event) => {
    logIpc('IN', 'gpt:syncCredentials');
    const window = BrowserWindow.fromWebContents(event.sender);
    try {
      const result = await GptCredentialSync.syncCredentials(window);
      logIpc('OUT', 'gpt:syncCredentials', result);
      return result;
    } catch (error) {
      logConsoleError('GptCredentialSync', 'Sync failed', error);
      logIpc('OUT', 'gpt:syncCredentials', { success: false, message: getErrorMessage(error) });
      return { success: false, message: getErrorMessage(error) };
    }
  });

  // WhatsApp handlers
  ipcMain.handle('whatsapp:hasCredentials', () => {
    logIpc('IN', 'whatsapp:hasCredentials');
    const hasCredentials = WhatsAppSync.hasCredentials();
    logIpc('OUT', 'whatsapp:hasCredentials', { hasCredentials });
    return hasCredentials;
  });

  ipcMain.handle('whatsapp:getLinkedPhoneNumber', () => {
    logIpc('IN', 'whatsapp:getLinkedPhoneNumber');
    const phoneNumber = WhatsAppSync.getLinkedPhoneNumber();
    logIpc('OUT', 'whatsapp:getLinkedPhoneNumber', { phoneNumber });
    return phoneNumber;
  });

  ipcMain.handle('whatsapp:isConnected', () => {
    logIpc('IN', 'whatsapp:isConnected');
    const connected = WhatsAppSync.isConnected();
    logIpc('OUT', 'whatsapp:isConnected', { connected });
    return connected;
  });

  ipcMain.handle('whatsapp:connect', async (event) => {
    logIpc('IN', 'whatsapp:connect');
    const window = BrowserWindow.fromWebContents(event.sender);
    try {
      // Backend registration is owned by WhatsAppSync.connect() so every
      // connect path (IPC, SyncManager auto-connect) gets it.
      await WhatsAppSync.connect({
        onQRCode: (qr: string) => {
          window?.webContents.send('whatsapp:qrCode', qr);
        },
      });
      logIpc('OUT', 'whatsapp:connect', { success: true });
      return { success: true };
    } catch (error) {
      logConsoleError('WhatsApp', 'Connect failed', error);
      logIpc('OUT', 'whatsapp:connect', { success: false, error: getErrorMessage(error) });
      return { success: false, error: getErrorMessage(error) || 'Connection failed' };
    }
  });

  ipcMain.handle('whatsapp:disconnect', async () => {
    logIpc('IN', 'whatsapp:disconnect');
    try {
      await WhatsAppSync.disconnect();
      logIpc('OUT', 'whatsapp:disconnect', { success: true });
      return { success: true };
    } catch (error) {
      logConsoleError('WhatsApp', 'Disconnect failed', error);
      logIpc('OUT', 'whatsapp:disconnect', { success: false, error: getErrorMessage(error) });
      return { success: false, error: getErrorMessage(error) || 'Disconnect failed' };
    }
  });

  ipcMain.handle('whatsapp:logout', async () => {
    logIpc('IN', 'whatsapp:logout');
    try {
      await WhatsAppSync.logout();
      logIpc('OUT', 'whatsapp:logout', { success: true });
      return { success: true };
    } catch (error) {
      logConsoleError('WhatsApp', 'Logout failed', error);
      logIpc('OUT', 'whatsapp:logout', { success: false, error: getErrorMessage(error) });
      return { success: false, error: getErrorMessage(error) || 'Logout failed' };
    }
  });

  // Telegram handlers
  ipcMain.handle('telegram:hasSession', () => {
    logIpc('IN', 'telegram:hasSession');
    const hasSession = TelegramSync.hasSession();
    logIpc('OUT', 'telegram:hasSession', { hasSession });
    return hasSession;
  });

  ipcMain.handle('telegram:hasApiCredentials', () => {
    logIpc('IN', 'telegram:hasApiCredentials');
    const hasCredentials = TelegramSync.hasApiCredentials();
    logIpc('OUT', 'telegram:hasApiCredentials', { hasCredentials });
    return hasCredentials;
  });

  ipcMain.handle('telegram:isConnected', () => {
    logIpc('IN', 'telegram:isConnected');
    const connected = TelegramSync.isConnected();
    logIpc('OUT', 'telegram:isConnected', { connected });
    return connected;
  });

  ipcMain.handle('telegram:connectWithExistingSession', async () => {
    logIpc('IN', 'telegram:connectWithExistingSession');
    try {
      const success = await TelegramSync.connectWithExistingSession();

      // Register the integration with the backend if connection succeeded
      if (success) {
        try {
          const session = await AuthService.getSession();
          if (session) {
            const response = await fetch(`${config.apiUrl}/api/integrations/telegram/connect`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${session.access_token}`,
                'Content-Type': 'application/json',
              },
            });

            if (response.ok) {
              logConsole('Telegram', 'Integration registered with backend (existing session)');
              // Invalidate cache so subsequent checks see the new integration
              IntegrationCache.invalidate();
              // Trigger historical sync now that we're connected
              TelegramSync.syncHistorical().catch((err) =>
                logConsoleError('Telegram', 'Historical sync error', err)
              );
            } else {
              logConsoleError('Telegram', 'Failed to register integration', await response.text());
            }
          }
        } catch (err) {
          logConsoleError('Telegram', 'Error registering integration', err);
        }
      }

      logIpc('OUT', 'telegram:connectWithExistingSession', { success });
      return { success };
    } catch (error) {
      logConsoleError('Telegram', 'Connect with existing session failed', error);
      logIpc('OUT', 'telegram:connectWithExistingSession', {
        success: false,
        error: getErrorMessage(error),
      });
      return { success: false, error: getErrorMessage(error) || 'Connection failed' };
    }
  });

  ipcMain.handle('telegram:disconnect', async () => {
    logIpc('IN', 'telegram:disconnect');
    try {
      await TelegramSync.disconnect();
      logIpc('OUT', 'telegram:disconnect', { success: true });
      return { success: true };
    } catch (error) {
      logConsoleError('Telegram', 'Disconnect failed', error);
      logIpc('OUT', 'telegram:disconnect', { success: false, error: getErrorMessage(error) });
      return { success: false, error: getErrorMessage(error) || 'Disconnect failed' };
    }
  });

  ipcMain.handle('telegram:logout', async () => {
    logIpc('IN', 'telegram:logout');
    try {
      await TelegramSync.logout();
      logIpc('OUT', 'telegram:logout', { success: true });
      return { success: true };
    } catch (error) {
      logConsoleError('Telegram', 'Logout failed', error);
      logIpc('OUT', 'telegram:logout', { success: false, error: getErrorMessage(error) });
      return { success: false, error: getErrorMessage(error) || 'Logout failed' };
    }
  });

  ipcMain.handle('telegram:syncHistorical', async (_, messagesPerDialog?: number) => {
    logIpc('IN', 'telegram:syncHistorical', { messagesPerDialog });
    try {
      const count = await TelegramSync.syncHistorical(messagesPerDialog);
      logIpc('OUT', 'telegram:syncHistorical', { success: true, count });
      return { success: true, count };
    } catch (error) {
      logConsoleError('Telegram', 'Historical sync failed', error);
      logIpc('OUT', 'telegram:syncHistorical', { success: false, error: getErrorMessage(error) });
      return { success: false, error: getErrorMessage(error) || 'Historical sync failed' };
    }
  });

  // Telegram auth flow handlers
  ipcMain.handle('telegram:startAuth', async (event, phoneNumber: string) => {
    logIpc('IN', 'telegram:startAuth', { phoneNumber: phoneNumber.slice(0, 4) + '***' });
    const window = BrowserWindow.fromWebContents(event.sender);

    try {
      const result = await TelegramSync.startAuth(phoneNumber);

      if (result.success) {
        // Set up event listeners on the client to forward to renderer
        const client = TelegramSync.getClient();
        if (client) {
          client.on('auth:needCode', () => {
            logConsole('Telegram', 'Auth: need code');
            window?.webContents.send('telegram:needCode');
          });

          client.on('auth:needPassword', () => {
            logConsole('Telegram', 'Auth: need password (2FA)');
            window?.webContents.send('telegram:needPassword');
          });

          client.on('auth:complete', () => {
            logConsole('Telegram', 'Auth: complete');

            // Notify renderer immediately; background register with backend.
            window?.webContents.send('telegram:authComplete');

            void (async () => {
              try {
                const session = await AuthService.getSession();
                if (session) {
                  const response = await fetch(
                    `${config.apiUrl}/api/integrations/telegram/connect`,
                    {
                      method: 'POST',
                      headers: {
                        Authorization: `Bearer ${session.access_token}`,
                        'Content-Type': 'application/json',
                      },
                    }
                  );

                  if (response.ok) {
                    logConsole('Telegram', 'Integration registered with backend');
                    // Invalidate cache so subsequent checks see the new integration
                    IntegrationCache.invalidate();
                    // Trigger historical sync now that we're connected
                    TelegramSync.syncHistorical().catch((err) =>
                      logConsoleError('Telegram', 'Historical sync error', err)
                    );
                  } else {
                    logConsoleError(
                      'Telegram',
                      'Failed to register integration',
                      await response.text()
                    );
                  }
                }
              } catch (err) {
                logConsoleError('Telegram', 'Error registering integration', err);
              }
            })();
          });

          client.on('auth:error', (errorMessage: string) => {
            logConsoleError('Telegram', 'Auth error', errorMessage);
            window?.webContents.send('telegram:authError', errorMessage);
          });
        }
      }

      logIpc('OUT', 'telegram:startAuth', result);
      return result;
    } catch (error) {
      logConsoleError('Telegram', 'Start auth failed', error);
      logIpc('OUT', 'telegram:startAuth', { success: false, error: getErrorMessage(error) });
      return { success: false, error: getErrorMessage(error) || 'Start auth failed' };
    }
  });

  ipcMain.handle('telegram:submitCode', (_, code: string) => {
    logIpc('IN', 'telegram:submitCode', { code: '***' });
    try {
      TelegramSync.submitCode(code);
      logIpc('OUT', 'telegram:submitCode', { success: true });
      return { success: true };
    } catch (error) {
      logConsoleError('Telegram', 'Submit code failed', error);
      logIpc('OUT', 'telegram:submitCode', { success: false, error: getErrorMessage(error) });
      return { success: false, error: getErrorMessage(error) || 'Submit code failed' };
    }
  });

  ipcMain.handle('telegram:submitPassword', (_, password: string) => {
    logIpc('IN', 'telegram:submitPassword', { password: '***' });
    try {
      TelegramSync.submitPassword(password);
      logIpc('OUT', 'telegram:submitPassword', { success: true });
      return { success: true };
    } catch (error) {
      logConsoleError('Telegram', 'Submit password failed', error);
      logIpc('OUT', 'telegram:submitPassword', { success: false, error: getErrorMessage(error) });
      return { success: false, error: getErrorMessage(error) || 'Submit password failed' };
    }
  });

  ipcMain.handle('telegram:cancelAuth', () => {
    logIpc('IN', 'telegram:cancelAuth');
    try {
      TelegramSync.cancelAuth();
      logIpc('OUT', 'telegram:cancelAuth', { success: true });
      return { success: true };
    } catch (error) {
      logConsoleError('Telegram', 'Cancel auth failed', error);
      logIpc('OUT', 'telegram:cancelAuth', { success: false, error: getErrorMessage(error) });
      return { success: false, error: getErrorMessage(error) || 'Cancel auth failed' };
    }
  });
}

// Auto-register on import
registerHandlers();

// Initialize all syncs via SyncManager (single entry point)
// Handles: iMessage, Telegram, WhatsApp, Cookies, BrowserState
// - Startup syncs for connected integrations
// - Periodic sync every 5 minutes
// - Real-time watchers (fs.watch, MTProto events, Baileys events)
SyncManager.startAll().catch((err) => logConsoleError('Startup', 'SyncManager startup error', err));
