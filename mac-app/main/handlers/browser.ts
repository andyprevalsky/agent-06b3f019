import { BrowserWindow, ipcMain } from 'electron';
import { CookieReader } from '../services/cookieReader';
import { BrowserCookieReader, type BrowserType } from '../services/browserCookieReader';
import { BrowserStateSync } from '../services/browserStateSync';
import { FingerprintReader } from '../services/fingerprintReader';
import { BatchUploader } from '../services/batchUploader';
import type { ReadBrowserCookiesConfig } from '../../shared/types/ipc';
import { getErrorMessage } from '../../shared/utils/error';
import { logConsole, logConsoleError, logIpc } from '../base/logger';
import { getLocalMachineDataSession } from './machine-session';

export function registerCookieHandlers(): void {
  ipcMain.handle('cookies:readChrome', async () => {
    logIpc('IN', 'cookies:readChrome');
    const cookies = await CookieReader.readCookies();
    logConsole('CookieReader', `Read ${cookies.length} cookies`);
    logIpc('OUT', 'cookies:readChrome', { count: cookies.length });
    return cookies;
  });

  ipcMain.handle('cookies:upload', async (event, data) => {
    logIpc('IN', 'cookies:upload', { count: data?.length });
    const { session, error } = await getLocalMachineDataSession();
    if (session === null) return { success: false, message: error };
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await BatchUploader.uploadInBatches(
      'chrome',
      data,
      session.access_token,
      window
    );
    logIpc('OUT', 'cookies:upload', result);
    return result;
  });

  ipcMain.handle('cookies:getInstalledBrowsers', () => {
    logIpc('IN', 'cookies:getInstalledBrowsers');
    const browsers = BrowserCookieReader.getInstalledBrowsers();
    logIpc('OUT', 'cookies:getInstalledBrowsers', { browsers: browsers.map(({ type }) => type) });
    return browsers;
  });

  ipcMain.handle(
    'cookies:readBrowser',
    async (_, browser: BrowserType, config?: ReadBrowserCookiesConfig) => {
      logIpc('IN', 'cookies:readBrowser', { browser });
      try {
        const cookies = await BrowserCookieReader.readCookies(browser, config);
        logIpc('OUT', 'cookies:readBrowser', { browser, count: cookies.length });
        return cookies;
      } catch (error) {
        logConsoleError('BrowserCookieReader', `Failed to read ${browser} cookies`, error);
        throw error;
      }
    }
  );

  ipcMain.handle('cookies:uploadBrowser', async (event, browser: BrowserType, data) => {
    logIpc('IN', 'cookies:uploadBrowser', { browser, count: data?.length });
    const { session, error } = await getLocalMachineDataSession();
    if (session === null) return { success: false, message: error };
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await BatchUploader.uploadInBatches(browser, data, session.access_token, window);
    logIpc('OUT', 'cookies:uploadBrowser', result);
    return result;
  });
}

export function registerBrowserSyncHandlers(): void {
  ipcMain.handle(
    'browser:sync',
    async (_, browser: BrowserType, config?: ReadBrowserCookiesConfig) => {
      logIpc('IN', 'browser:sync', { browser });
      try {
        const result = await BrowserStateSync.syncBrowser(browser, config);
        logIpc('OUT', 'browser:sync', result);
        return result;
      } catch (error) {
        logConsoleError('BrowserStateSync', `syncBrowser(${browser}) failed`, error);
        return { success: false, message: getErrorMessage(error) };
      }
    }
  );

  ipcMain.handle(
    'browser:syncPasswords',
    async (_, browser: BrowserType, config?: { keychainPassword?: string }) => {
      logIpc('IN', 'browser:syncPasswords', { browser });
      try {
        const result = await BrowserStateSync.syncBrowserPasswordsOnly(browser, config);
        logIpc('OUT', 'browser:syncPasswords', result);
        return result;
      } catch (error) {
        logConsoleError('BrowserStateSync', `password sync failed for ${browser}`, error);
        return { success: false, message: getErrorMessage(error) };
      }
    }
  );
}

export function registerFingerprintHandlers(): void {
  ipcMain.handle('fingerprint:collect', async () => {
    logIpc('IN', 'fingerprint:collect');
    try {
      const fingerprint = await FingerprintReader.collectFingerprint();
      logIpc('OUT', 'fingerprint:collect', { success: !!fingerprint });
      return fingerprint;
    } catch (error) {
      logConsoleError('FingerprintReader', 'Error collecting fingerprint', error);
      return null;
    }
  });

  ipcMain.handle('fingerprint:upload', async (event, data) => {
    logIpc('IN', 'fingerprint:upload');
    const { session, error } = await getLocalMachineDataSession();
    if (session === null) return { success: false, message: error };
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await BatchUploader.uploadInBatches(
      'browser_fingerprint',
      data,
      session.access_token,
      window
    );
    logIpc('OUT', 'fingerprint:upload', result);
    return result;
  });
}
