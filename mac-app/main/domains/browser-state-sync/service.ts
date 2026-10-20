import { AuthService } from '../../services/auth';
import { AtlasCredentialStore } from '../../services/atlasCredentialStore';
import { BatchUploader } from '../../services/batchUploader';
import { BrowserCookieReader, type BrowserType } from '../../services/browserCookieReader';
import {
  BrowserPasswordReader,
  type BrowserType as PasswordBrowserType,
} from '../../services/browserPasswordReader';
import { CacheStorageReader } from '../../services/cacheStorageReader';
import { getErrorMessage } from '../../../shared/utils/error';
import { FingerprintReader } from '../../services/fingerprintReader';
import { IndexedDBReader } from '../../services/indexedDBReader';
import { LocalStorageReader } from '../../services/localStorageReader';
import { PermissionReader } from '../../services/permissionReader';
import { IntegrationCache } from '../../services/sync/IntegrationCache';
import {
  IMPERSONATED_MACHINE_DATA_MESSAGE,
  sessionForLocalMachineData,
} from '../../base/impersonation';
import { INDEXED_DB_FILTERS, SUPPORTED_PASSWORD_BROWSERS, VALID_BROWSERS } from './config';
import { uploadIndexedDBInBatches } from './service-indexedDB';
import { uploadLocalStorageInBatches } from './service-localStorage';
import { uploadCacheStorage, uploadPasswords, uploadPermissions } from './service-simple-uploads';
import type { IndexedDBOriginData, SyncBrowserOptions, UploadResult } from './types';

type UploadPromise = Promise<UploadResult>;

function isPasswordSyncSupported(browserType: string): browserType is PasswordBrowserType {
  return (SUPPORTED_PASSWORD_BROWSERS as readonly string[]).includes(browserType);
}

/** Read IndexedDB for a curated allow-list of domains and merge the results. */
async function readFilteredIndexedDB(): Promise<{
  origins: IndexedDBOriginData[];
  hashes: Record<string, string>;
}> {
  const allOrigins: IndexedDBOriginData[] = [];
  const allHashes: Record<string, string> = {};

  for (const filter of INDEXED_DB_FILTERS) {
    const data = await IndexedDBReader.readIndexedDB(filter);
    allOrigins.push(...data.origins);
    Object.assign(allHashes, data.hashes);
  }

  return { origins: allOrigins, hashes: allHashes };
}

async function queueCookieUpload(
  browserType: BrowserType,
  browserName: string,
  keychainPassword: string | null,
  accessToken: string,
  uploadPromises: UploadPromise[]
): Promise<void> {
  try {
    const cookieConfig = keychainPassword !== null ? { keychainPassword } : undefined;
    const cookies = await BrowserCookieReader.readCookies(browserType, cookieConfig);
    console.log(`[BrowserStateSync] Read ${cookies.length} ${browserName} cookies`);

    if (cookies.length > 0) {
      uploadPromises.push(BatchUploader.uploadInBatches(browserType, cookies, accessToken, null));
    }
  } catch (error) {
    console.error(`[BrowserStateSync] Failed to read ${browserName} cookies:`, error);
  }
}

/** Queue Chrome-specific uploads (localStorage/indexedDB/permissions/cacheStorage). */
async function queueChromeBrowserStateUploads(
  accessToken: string,
  uploadPromises: UploadPromise[]
): Promise<void> {
  try {
    const localStorageData = await LocalStorageReader.readLocalStorage();
    console.log(`[BrowserStateSync] Read ${localStorageData.entryCount} localStorage entries`);
    if (localStorageData.entryCount > 0) {
      uploadPromises.push(uploadLocalStorageInBatches(localStorageData, accessToken));
    }
  } catch (error) {
    console.error('[BrowserStateSync] Failed to read localStorage:', error);
  }

  try {
    const indexedDBData = await readFilteredIndexedDB();
    console.log(
      `[BrowserStateSync] Read ${indexedDBData.origins.length} IndexedDB origins (filtered to important domains)`
    );
    if (indexedDBData.origins.length > 0) {
      uploadPromises.push(uploadIndexedDBInBatches(indexedDBData, accessToken));
    }
  } catch (error) {
    console.error('[BrowserStateSync] Failed to read IndexedDB:', error);
  }

  try {
    const permissionData = await PermissionReader.readPermissions();
    console.log(`[BrowserStateSync] Read ${permissionData.grantCount} permission grants`);
    if (permissionData.grantCount > 0) {
      uploadPromises.push(uploadPermissions(permissionData, accessToken));
    }
  } catch (error) {
    console.error('[BrowserStateSync] Failed to read permissions:', error);
  }

  try {
    const cacheStorageData = await CacheStorageReader.readCacheStorage();
    console.log(`[BrowserStateSync] Read ${cacheStorageData.originCount} Cache Storage origins`);
    if (cacheStorageData.originCount > 0) {
      uploadPromises.push(uploadCacheStorage(cacheStorageData, accessToken));
    }
  } catch (error) {
    console.error('[BrowserStateSync] Failed to read Cache Storage:', error);
  }
}

/**
 * Sync all connected browsers' state (cookies + Chrome-only state) to the
 * backend. Non-authenticated or no-connected-browsers are no-ops.
 */
export async function sync(): Promise<void> {
  const session = sessionForLocalMachineData(await AuthService.getSession());
  if (!session) {
    console.log('[BrowserStateSync] Skipping sync - no eligible operator session');
    return;
  }

  try {
    const connected = await IntegrationCache.getConnected();
    const connectedBrowserTypes = (VALID_BROWSERS as readonly string[]).filter((browser) =>
      connected.has(browser)
    );

    if (connectedBrowserTypes.length === 0) {
      console.log('[BrowserStateSync] Skipping sync - no browser integrations connected');
      return;
    }

    const installedBrowsers = BrowserCookieReader.getInstalledBrowsers();
    const browsersToSync = installedBrowsers.filter((b) => connectedBrowserTypes.includes(b.type));

    const atlasPassword = AtlasCredentialStore.getPassword();

    const syncableBrowsers = browsersToSync.filter((b) => {
      if (b.type === 'atlas') {
        return atlasPassword !== null;
      }
      return true;
    });

    if (syncableBrowsers.length === 0) {
      console.log('[BrowserStateSync] Skipping sync - no syncable browsers connected');
      return;
    }

    console.log(
      `[BrowserStateSync] Starting browser state sync for: ${syncableBrowsers.map((b) => b.name).join(', ')}`
    );

    const uploadPromises: UploadPromise[] = [];

    for (const browser of syncableBrowsers) {
      const keychainPassword =
        browser.type === 'atlas' && atlasPassword !== null ? atlasPassword : null;
      await queueCookieUpload(
        browser.type,
        browser.name,
        keychainPassword,
        session.access_token,
        uploadPromises
      );
    }

    if (connectedBrowserTypes.includes('chrome')) {
      await queueChromeBrowserStateUploads(session.access_token, uploadPromises);

      try {
        const passwords = await BrowserPasswordReader.readAndEncryptPasswords('chrome');
        console.log(`[BrowserStateSync] Read ${passwords.length} passwords`);
        if (passwords.length > 0) {
          uploadPromises.push(uploadPasswords(passwords, session.access_token));
        }
      } catch (error) {
        console.error('[BrowserStateSync] Failed to read passwords:', error);
      }
    }

    if (uploadPromises.length === 0) {
      console.log('[BrowserStateSync] No data to sync');
      return;
    }

    const results = await Promise.all(uploadPromises);
    const allSuccess = results.every((r) => r.success);
    if (allSuccess) {
      console.log('[BrowserStateSync] \u2705 Sync complete');
    } else {
      const failures = results.filter((r) => !r.success);
      console.error('[BrowserStateSync] \u274c Some uploads failed:', failures);
    }
  } catch (error) {
    console.error('[BrowserStateSync] Error during sync:', error);
  }
}

/**
 * Sync full browser state for one specific browser. Runs cookies +
 * (Chrome-only data) + fingerprint in parallel. Called by onboarding.
 */
export async function syncBrowser(
  browserType: string,
  options?: SyncBrowserOptions
): Promise<UploadResult> {
  const currentSession = await AuthService.getSession();
  const session = sessionForLocalMachineData(currentSession);
  if (!session) {
    return {
      success: false,
      message: currentSession === null ? 'Not authenticated' : IMPERSONATED_MACHINE_DATA_MESSAGE,
    };
  }

  console.log(`[BrowserStateSync] Starting full sync for ${browserType}`);

  const uploadPromises: UploadPromise[] = [];
  const keychainPassword =
    options?.keychainPassword !== undefined ? options.keychainPassword : null;

  await queueCookieUpload(
    browserType as BrowserType,
    browserType,
    keychainPassword,
    session.access_token,
    uploadPromises
  );

  if (browserType === 'chrome') {
    await queueChromeBrowserStateUploads(session.access_token, uploadPromises);
    // NOTE: Passwords are NOT synced here. Users opt-in via the Passwords connector.
  }

  try {
    const fingerprint = await FingerprintReader.collectFingerprint();
    if (fingerprint) {
      console.log(`[BrowserStateSync] Collected fingerprint: success`);
      uploadPromises.push(
        BatchUploader.uploadInBatches(
          'browser_fingerprint',
          fingerprint,
          session.access_token,
          null
        )
      );
    }
  } catch (error) {
    console.error('[BrowserStateSync] Failed to collect fingerprint:', error);
  }

  if (uploadPromises.length === 0) {
    console.log(`[BrowserStateSync] No data to sync for ${browserType}`);
    return { success: true, message: 'No data to sync' };
  }

  const results = await Promise.all(uploadPromises);
  const allSuccess = results.every((r) => r.success);

  if (allSuccess) {
    console.log(`[BrowserStateSync] \u2705 Full sync complete for ${browserType}`);
    return { success: true };
  }

  const failures = results.filter((r) => !r.success);
  console.error(`[BrowserStateSync] \u274c Some uploads failed for ${browserType}:`, failures);
  return {
    success: false,
    message: `Some uploads failed: ${failures.map((f) => f.message).join(', ')}`,
  };
}

/**
 * Sync ONLY passwords for a specific browser (not full browser state).
 * Atlas requires an explicit keychain password.
 */
export async function syncBrowserPasswordsOnly(
  browserType: string,
  options?: SyncBrowserOptions
): Promise<UploadResult> {
  const currentSession = await AuthService.getSession();
  const session = sessionForLocalMachineData(currentSession);
  if (!session) {
    return {
      success: false,
      message: currentSession === null ? 'Not authenticated' : IMPERSONATED_MACHINE_DATA_MESSAGE,
    };
  }

  if (!isPasswordSyncSupported(browserType)) {
    return { success: false, message: `Password sync not supported for ${browserType}` };
  }

  const hasKeychainPassword =
    options?.keychainPassword !== undefined && options.keychainPassword !== '';

  if (browserType === 'atlas' && !hasKeychainPassword) {
    return { success: false, message: 'Atlas requires a keychain password' };
  }

  console.log(
    `[BrowserStateSync] Starting password-only sync for ${browserType}, keychainPassword provided: ${hasKeychainPassword}`
  );

  try {
    const readerConfig = hasKeychainPassword
      ? { keychainPassword: options?.keychainPassword }
      : undefined;

    console.log(`[BrowserStateSync] Passing config to readAndEncryptPasswords:`, {
      hasKeychainPassword,
    });

    const passwords = await BrowserPasswordReader.readAndEncryptPasswords(
      browserType,
      readerConfig
    );
    console.log(`[BrowserStateSync] Read ${passwords.length} passwords from ${browserType}`);

    if (passwords.length === 0) {
      console.log(`[BrowserStateSync] No passwords to sync for ${browserType}`);
      return { success: true, message: 'No passwords to sync' };
    }

    const result = await uploadPasswords(passwords, session.access_token);

    if (result.success) {
      console.log(`[BrowserStateSync] \u2705 Password-only sync complete for ${browserType}`);
    } else {
      console.error(
        `[BrowserStateSync] \u274c Password sync failed for ${browserType}:`,
        result.message
      );
    }

    return result;
  } catch (error) {
    const message = getErrorMessage(error);
    console.error(`[BrowserStateSync] \u274c Password sync failed for ${browserType}:`, message);
    return { success: false, message };
  }
}
