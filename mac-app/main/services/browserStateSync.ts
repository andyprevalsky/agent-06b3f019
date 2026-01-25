import { config } from '../base/config';
import { AuthService } from './auth';
import { BrowserCookieReader } from './browserCookieReader';
import { BrowserPasswordReader } from './browserPasswordReader';
import { LocalStorageReader, LocalStorageData } from './localStorageReader';
import { IndexedDBReader, IndexedDBData, IndexedDBOriginData } from './indexedDBReader';
import { PermissionReader, PermissionData } from './permissionReader';
import { CacheStorageReader, CacheStorageData } from './cacheStorageReader';
import { FingerprintReader } from './fingerprintReader';
import { BatchUploader } from './batchUploader';
import { AtlasCredentialStore } from './atlasCredentialStore';
import { Crypto } from '../base/crypto';
import zlib from 'zlib';
import { promisify } from 'util';

const gzip = promisify(zlib.gzip);

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const ORIGINS_PER_BATCH = 100; // Number of origins per batch
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

interface Integration {
  name: string;
  status: string;
}

interface LocalStorageBatch {
  byOrigin: Record<string, { key: string; value: string }[]>;
  hashes: Record<string, string>;
  batchIndex: number;
  totalBatches: number;
  entryCount: number;
  originCount: number;
}

interface IndexedDBBatch {
  origins: IndexedDBOriginData[];
  hashes: Record<string, string>;
  batchIndex: number;
  totalBatches: number;
}

/**
 * BrowserStateSync coordinates syncing of all browser state:
 * - Cookies (from CookieReader)
 * - localStorage (from LocalStorageReader)
 *
 * Uploads happen in parallel for better performance.
 * localStorage is batched by origins and compressed with gzip.
 */
export class BrowserStateSync {
  private static intervalId: NodeJS.Timeout | null = null;

  /**
   * Split localStorage data into batches by origins.
   */
  private static splitIntoBatches(data: LocalStorageData): LocalStorageBatch[] {
    const origins = Object.keys(data.byOrigin);
    const totalBatches = Math.ceil(origins.length / ORIGINS_PER_BATCH);
    const batches: LocalStorageBatch[] = [];

    for (let i = 0; i < origins.length; i += ORIGINS_PER_BATCH) {
      const batchOrigins = origins.slice(i, i + ORIGINS_PER_BATCH);
      const byOrigin: Record<string, { key: string; value: string }[]> = {};
      const hashes: Record<string, string> = {};
      let entryCount = 0;

      for (const origin of batchOrigins) {
        byOrigin[origin] = data.byOrigin[origin];
        hashes[origin] = data.hashes[origin];
        entryCount += data.byOrigin[origin].length;
      }

      batches.push({
        byOrigin,
        hashes,
        batchIndex: batches.length,
        totalBatches,
        entryCount,
        originCount: batchOrigins.length,
      });
    }

    return batches;
  }

  /**
   * Upload a single batch with compression and retries.
   */
  private static async uploadBatchWithRetry(
    batch: LocalStorageBatch,
    accessToken: string
  ): Promise<{ success: boolean; message?: string }> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        // 1. Serialize to JSON
        const jsonData = JSON.stringify(batch);

        // 2. Compress with gzip
        const compressed = await gzip(Buffer.from(jsonData, 'utf8'));

        // 3. Encrypt the compressed data
        const { encrypted, iv, key } = Crypto.encrypt(compressed);

        // 4. Upload via FormData
        const formData = new FormData();
        formData.append('data', encrypted);
        formData.append('iv', iv);
        formData.append('key', key);
        formData.append('compressed', 'true');

        const response = await fetch(`${config.apiUrl}/api/integrations/localStorage/upload`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
          },
          body: formData,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Upload failed: ${response.status} ${errorText}`);
        }

        console.log(`[BrowserStateSync] ✅ Batch ${batch.batchIndex + 1}/${batch.totalBatches} uploaded (${batch.originCount} origins, ${batch.entryCount} entries)`);
        return { success: true };

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`[BrowserStateSync] Batch ${batch.batchIndex + 1} upload attempt ${attempt + 1} failed:`, lastError.message);

        if (attempt < MAX_RETRIES - 1) {
          const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    return { success: false, message: lastError?.message || 'Unknown error after retries' };
  }

  /**
   * Upload localStorage in batches with compression.
   * Each batch directly bulk-upserts to LocalStorageOrigin - no finalize step needed.
   */
  private static async uploadLocalStorageInBatches(
    data: LocalStorageData,
    accessToken: string
  ): Promise<{ success: boolean; message?: string }> {
    const batches = this.splitIntoBatches(data);

    console.log(`[BrowserStateSync] Uploading localStorage in ${batches.length} batches (${data.originCount} origins, ${data.entryCount} entries)`);

    // Upload all batches in PARALLEL - each batch directly upserts to DB
    const uploadResults = await Promise.all(
      batches.map(batch => this.uploadBatchWithRetry(batch, accessToken))
    );

    const failedBatches = uploadResults
      .map((result, index) => result.success ? null : index)
      .filter((index): index is number => index !== null);

    if (failedBatches.length > 0) {
      console.error(`[BrowserStateSync] ❌ Failed batches: ${failedBatches.map(i => i + 1).join(', ')} of ${batches.length}`);
      return {
        success: false,
        message: `Failed batches: ${failedBatches.map(i => i + 1).join(', ')} of ${batches.length}`,
      };
    }

    console.log(`[BrowserStateSync] ✅ All ${batches.length} batches uploaded`);
    return { success: true };
  }

  /**
   * Split IndexedDB data into batches by origins.
   */
  private static splitIndexedDBIntoBatches(data: IndexedDBData): IndexedDBBatch[] {
    const origins = data.origins;
    const totalBatches = Math.ceil(origins.length / ORIGINS_PER_BATCH);
    const batches: IndexedDBBatch[] = [];

    for (let i = 0; i < origins.length; i += ORIGINS_PER_BATCH) {
      const batchOrigins = origins.slice(i, i + ORIGINS_PER_BATCH);
      const hashes: Record<string, string> = {};

      for (const origin of batchOrigins) {
        if (data.hashes[origin.origin]) {
          hashes[origin.origin] = data.hashes[origin.origin];
        }
      }

      batches.push({
        origins: batchOrigins,
        hashes,
        batchIndex: batches.length,
        totalBatches,
      });
    }

    return batches;
  }

  /**
   * Upload a single IndexedDB batch with compression and retries.
   */
  private static async uploadIndexedDBBatchWithRetry(
    batch: IndexedDBBatch,
    accessToken: string
  ): Promise<{ success: boolean; message?: string }> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        // 1. Serialize to JSON
        const jsonData = JSON.stringify(batch);

        // 2. Compress with gzip
        const compressed = await gzip(Buffer.from(jsonData, 'utf8'));

        // 3. Encrypt the compressed data
        const { encrypted, iv, key } = Crypto.encrypt(compressed);

        // 4. Upload via FormData
        const formData = new FormData();
        formData.append('data', encrypted);
        formData.append('iv', iv);
        formData.append('key', key);
        formData.append('compressed', 'true');

        const response = await fetch(`${config.apiUrl}/api/integrations/indexedDB/upload`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
          },
          body: formData,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Upload failed: ${response.status} ${errorText}`);
        }

        console.log(`[BrowserStateSync] ✅ IndexedDB batch ${batch.batchIndex + 1}/${batch.totalBatches} uploaded (${batch.origins.length} origins)`);
        return { success: true };

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`[BrowserStateSync] IndexedDB batch ${batch.batchIndex + 1} upload attempt ${attempt + 1} failed:`, lastError.message);

        if (attempt < MAX_RETRIES - 1) {
          const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    return { success: false, message: lastError?.message || 'Unknown error after retries' };
  }

  /**
   * Upload IndexedDB in batches with compression.
   */
  private static async uploadIndexedDBInBatches(
    data: IndexedDBData,
    accessToken: string
  ): Promise<{ success: boolean; message?: string }> {
    if (data.origins.length === 0) {
      return { success: true };
    }

    const batches = this.splitIndexedDBIntoBatches(data);

    console.log(`[BrowserStateSync] Uploading IndexedDB in ${batches.length} batches (${data.origins.length} origins)`);

    // Upload all batches in PARALLEL
    const uploadResults = await Promise.all(
      batches.map(batch => this.uploadIndexedDBBatchWithRetry(batch, accessToken))
    );

    const failedBatches = uploadResults
      .map((result, index) => result.success ? null : index)
      .filter((index): index is number => index !== null);

    if (failedBatches.length > 0) {
      console.error(`[BrowserStateSync] ❌ Failed IndexedDB batches: ${failedBatches.map(i => i + 1).join(', ')} of ${batches.length}`);
      return {
        success: false,
        message: `Failed batches: ${failedBatches.map(i => i + 1).join(', ')} of ${batches.length}`,
      };
    }

    console.log(`[BrowserStateSync] ✅ All ${batches.length} IndexedDB batches uploaded`);
    return { success: true };
  }

  /**
   * Upload permissions with encryption.
   */
  private static async uploadPermissions(
    data: PermissionData,
    accessToken: string
  ): Promise<{ success: boolean; message?: string }> {
    if (data.grants.length === 0) {
      return { success: true };
    }

    try {
      // Serialize to JSON
      const jsonData = JSON.stringify(data);

      // Encrypt the data
      const { encrypted, iv, key } = Crypto.encrypt(Buffer.from(jsonData, 'utf8'));

      // Upload via FormData
      const formData = new FormData();
      formData.append('data', encrypted);
      formData.append('iv', iv);
      formData.append('key', key);

      const response = await fetch(`${config.apiUrl}/api/integrations/permissions/upload`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Upload failed: ${response.status} ${errorText}`);
      }

      console.log(`[BrowserStateSync] ✅ Uploaded ${data.grants.length} permission grants`);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[BrowserStateSync] ❌ Failed to upload permissions:`, message);
      return { success: false, message };
    }
  }

  /**
   * Upload Cache Storage metadata with encryption and compression.
   */
  private static async uploadCacheStorage(
    data: CacheStorageData,
    accessToken: string
  ): Promise<{ success: boolean; message?: string }> {
    if (data.origins.length === 0) {
      return { success: true };
    }

    try {
      // Serialize to JSON
      const jsonData = JSON.stringify(data);

      // Compress with gzip
      const compressed = await gzip(Buffer.from(jsonData, 'utf8'));

      // Encrypt the compressed data
      const { encrypted, iv, key } = Crypto.encrypt(compressed);

      // Upload via FormData
      const formData = new FormData();
      formData.append('data', encrypted);
      formData.append('iv', iv);
      formData.append('key', key);
      formData.append('compressed', 'true');

      const response = await fetch(`${config.apiUrl}/api/integrations/cacheStorage/upload`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Upload failed: ${response.status} ${errorText}`);
      }

      console.log(`[BrowserStateSync] ✅ Uploaded ${data.origins.length} Cache Storage origins`);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[BrowserStateSync] ❌ Failed to upload Cache Storage:`, message);
      return { success: false, message };
    }
  }

  /**
   * Upload passwords with encryption.
   * Passwords are already RSA-encrypted by BrowserPasswordReader.
   */
  private static async uploadPasswords(
    passwords: Array<{
      origin: string;
      username: string;
      encryptedPassword: string;
      dateLastUsed: number;
      dateCreated: number;
      browserSource: string;
    }>,
    accessToken: string
  ): Promise<{ success: boolean; message?: string }> {
    if (passwords.length === 0) {
      return { success: true };
    }

    try {
      // Serialize to JSON
      const jsonData = JSON.stringify({ passwords });

      // Encrypt with AES for transport (passwords are already RSA-encrypted)
      const { encrypted, iv, key } = Crypto.encrypt(Buffer.from(jsonData, 'utf8'));

      // Upload via FormData
      const formData = new FormData();
      formData.append('data', encrypted);
      formData.append('iv', iv);
      formData.append('key', key);

      const response = await fetch(`${config.apiUrl}/api/integrations/passwords/upload`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Upload failed: ${response.status} ${errorText}`);
      }

      console.log(`[BrowserStateSync] ✅ Uploaded ${passwords.length} passwords`);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[BrowserStateSync] ❌ Failed to upload passwords:`, message);
      return { success: false, message };
    }
  }

  /**
   * Sync all browser state (cookies + localStorage + IndexedDB) to the backend.
   * Syncs all connected browsers:
   * - Standard browsers (Chrome, Edge, etc.): Auto-retrieve keychain password
   * - Atlas: Use stored password from AtlasCredentialStore (if available)
   */
  static async sync(): Promise<void> {
    const session = await AuthService.getSession();
    if (!session) {
      console.log('[BrowserStateSync] Skipping sync - not authenticated');
      return;
    }

    try {
      // Check which browser integrations are connected
      const response = await fetch(`${config.apiUrl}/api/integrations`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        console.error('[BrowserStateSync] Failed to fetch integrations:', response.statusText);
        return;
      }

      const data = await response.json() as { integrations?: Integration[] };
      const integrations = data.integrations ?? [];

      // Find all connected browser integrations
      // Integration names are browser types: 'chrome', 'edge', 'atlas', etc.
      const validBrowsers = ['chrome', 'edge', 'brave', 'arc', 'opera', 'vivaldi', 'chromium', 'atlas', 'safari', 'firefox'];
      const connectedBrowserTypes = integrations
        .filter(i => validBrowsers.includes(i.name) && i.status === 'CONNECTED')
        .map(i => i.name);

      if (connectedBrowserTypes.length === 0) {
        console.log('[BrowserStateSync] Skipping sync - no browser integrations connected');
        return;
      }

      // Get installed browsers that are connected
      const installedBrowsers = BrowserCookieReader.getInstalledBrowsers();
      const browsersToSync = installedBrowsers.filter(
        b => connectedBrowserTypes.includes(b.type)
      );

      // Check if Atlas has a stored password
      const atlasPassword = AtlasCredentialStore.getPassword();

      // Filter to browsers we can actually sync
      const syncableBrowsers = browsersToSync.filter(b => {
        if (b.type === 'atlas') {
          // Atlas requires stored password
          return atlasPassword !== null;
        }
        // Other browsers use automatic keychain access
        return true;
      });

      if (syncableBrowsers.length === 0) {
        console.log('[BrowserStateSync] Skipping sync - no syncable browsers connected');
        return;
      }

      console.log(`[BrowserStateSync] Starting browser state sync for: ${syncableBrowsers.map(b => b.name).join(', ')}`);

      // Upload promises for all data types
      const uploadPromises: Promise<{ success: boolean; message?: string }>[] = [];

      // Read and upload cookies for each syncable browser
      for (const browser of syncableBrowsers) {
        try {
          // For Atlas, use the stored password
          const config = browser.type === 'atlas' && atlasPassword
            ? { keychainPassword: atlasPassword }
            : undefined;

          const cookies = await BrowserCookieReader.readCookies(browser.type, config);
          console.log(`[BrowserStateSync] Read ${cookies.length} ${browser.name} cookies`);

          if (cookies.length > 0) {
            uploadPromises.push(
              BatchUploader.uploadInBatches(browser.type, cookies, session.access_token, null)
            );
          }
        } catch (error) {
          console.error(`[BrowserStateSync] Failed to read ${browser.name} cookies:`, error);
        }
      }

      // Only sync localStorage, IndexedDB, permissions, and Cache Storage if Chrome is connected
      // (these readers currently only support Chrome paths)
      if (connectedBrowserTypes.includes('chrome')) {
        // Read and upload localStorage
        try {
          const localStorageData = await LocalStorageReader.readLocalStorage();
          console.log(`[BrowserStateSync] Read ${localStorageData.entryCount} localStorage entries`);

          if (localStorageData.entryCount > 0) {
            uploadPromises.push(
              this.uploadLocalStorageInBatches(localStorageData, session.access_token)
            );
          }
        } catch (error) {
          console.error('[BrowserStateSync] Failed to read localStorage:', error);
        }

        // Read and upload IndexedDB (requires Python with ccl_chromium_reader)
        // Only sync important domains to avoid slow full scans
        const indexedDBFilters = ['amazon', 'google', 'doordash', 'instacart', 'uber', 'netflix', 'spotify'];
        try {
          // Read IndexedDB for each important domain
          const allOrigins: IndexedDBOriginData[] = [];
          const allHashes: Record<string, string> = {};

          for (const filter of indexedDBFilters) {
            const data = await IndexedDBReader.readIndexedDB(filter);
            allOrigins.push(...data.origins);
            Object.assign(allHashes, data.hashes);
          }

          const indexedDBData = { origins: allOrigins, hashes: allHashes };
          console.log(`[BrowserStateSync] Read ${indexedDBData.origins.length} IndexedDB origins (filtered to important domains)`);

          if (indexedDBData.origins.length > 0) {
            uploadPromises.push(
              this.uploadIndexedDBInBatches(indexedDBData, session.access_token)
            );
          }
        } catch (error) {
          console.error('[BrowserStateSync] Failed to read IndexedDB:', error);
        }

        // Read and upload permissions from Chrome Preferences
        try {
          const permissionData = await PermissionReader.readPermissions();
          console.log(`[BrowserStateSync] Read ${permissionData.grantCount} permission grants`);

          if (permissionData.grantCount > 0) {
            uploadPromises.push(
              this.uploadPermissions(permissionData, session.access_token)
            );
          }
        } catch (error) {
          console.error('[BrowserStateSync] Failed to read permissions:', error);
        }

        // Read and upload Cache Storage metadata
        try {
          const cacheStorageData = await CacheStorageReader.readCacheStorage();
          console.log(`[BrowserStateSync] Read ${cacheStorageData.originCount} Cache Storage origins`);

          if (cacheStorageData.originCount > 0) {
            uploadPromises.push(
              this.uploadCacheStorage(cacheStorageData, session.access_token)
            );
          }
        } catch (error) {
          console.error('[BrowserStateSync] Failed to read Cache Storage:', error);
        }

        // Read and upload passwords (Chrome only for now)
        try {
          const passwords = await BrowserPasswordReader.readAndEncryptPasswords('chrome');
          console.log(`[BrowserStateSync] Read ${passwords.length} passwords`);

          if (passwords.length > 0) {
            uploadPromises.push(
              this.uploadPasswords(passwords, session.access_token)
            );
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

      const allSuccess = results.every(r => r.success);
      if (allSuccess) {
        console.log('[BrowserStateSync] ✅ Sync complete');
      } else {
        const failures = results.filter(r => !r.success);
        console.error('[BrowserStateSync] ❌ Some uploads failed:', failures);
      }

    } catch (error) {
      console.error('[BrowserStateSync] Error during sync:', error);
    }
  }

  /**
   * Start background sync that runs every 5 minutes.
   */
  static startBackgroundSync(): void {
    if (this.intervalId) {
      console.log('[BrowserStateSync] Background sync already running');
      return;
    }

    console.log(`[BrowserStateSync] Starting background sync (every ${SYNC_INTERVAL_MS / 1000 / 60} minutes)`);
    this.intervalId = setInterval(() => {
      this.sync().catch(err => console.error('[BrowserStateSync] Background sync error:', err));
    }, SYNC_INTERVAL_MS);
  }

  /**
   * Stop background sync.
   */
  static stopBackgroundSync(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[BrowserStateSync] Background sync stopped');
    }
  }

  /**
   * Sync all browser state for a specific browser.
   * Runs cookies + localStorage + IndexedDB + permissions + Cache Storage in parallel.
   * Called from onboarding when user clicks sync on a browser.
   */
  static async syncBrowser(
    browserType: string,
    options?: { keychainPassword?: string }
  ): Promise<{ success: boolean; message?: string }> {
    const session = await AuthService.getSession();
    if (!session) {
      return { success: false, message: 'Not authenticated' };
    }

    console.log(`[BrowserStateSync] Starting full sync for ${browserType}`);

    const uploadPromises: Promise<{ success: boolean; message?: string }>[] = [];

    // 1. Read and upload cookies
    try {
      const config = options?.keychainPassword
        ? { keychainPassword: options.keychainPassword }
        : undefined;

      const cookies = await BrowserCookieReader.readCookies(browserType as any, config);
      console.log(`[BrowserStateSync] Read ${cookies.length} ${browserType} cookies`);

      if (cookies.length > 0) {
        uploadPromises.push(
          BatchUploader.uploadInBatches(browserType, cookies, session.access_token, null)
        );
      }
    } catch (error) {
      console.error(`[BrowserStateSync] Failed to read ${browserType} cookies:`, error);
    }

    // 2. For Chrome, also sync localStorage, IndexedDB, permissions, and Cache Storage
    if (browserType === 'chrome') {
      // localStorage
      try {
        const localStorageData = await LocalStorageReader.readLocalStorage();
        console.log(`[BrowserStateSync] Read ${localStorageData.entryCount} localStorage entries`);

        if (localStorageData.entryCount > 0) {
          uploadPromises.push(
            this.uploadLocalStorageInBatches(localStorageData, session.access_token)
          );
        }
      } catch (error) {
        console.error('[BrowserStateSync] Failed to read localStorage:', error);
      }

      // IndexedDB (filtered to important domains)
      const indexedDBFilters = ['amazon', 'google', 'doordash', 'instacart', 'uber', 'netflix', 'spotify'];
      try {
        const allOrigins: IndexedDBOriginData[] = [];
        const allHashes: Record<string, string> = {};

        for (const filter of indexedDBFilters) {
          const data = await IndexedDBReader.readIndexedDB(filter);
          allOrigins.push(...data.origins);
          Object.assign(allHashes, data.hashes);
        }

        const indexedDBData = { origins: allOrigins, hashes: allHashes };
        console.log(`[BrowserStateSync] Read ${indexedDBData.origins.length} IndexedDB origins`);

        if (indexedDBData.origins.length > 0) {
          uploadPromises.push(
            this.uploadIndexedDBInBatches(indexedDBData, session.access_token)
          );
        }
      } catch (error) {
        console.error('[BrowserStateSync] Failed to read IndexedDB:', error);
      }

      // Permissions
      try {
        const permissionData = await PermissionReader.readPermissions();
        console.log(`[BrowserStateSync] Read ${permissionData.grantCount} permission grants`);

        if (permissionData.grantCount > 0) {
          uploadPromises.push(
            this.uploadPermissions(permissionData, session.access_token)
          );
        }
      } catch (error) {
        console.error('[BrowserStateSync] Failed to read permissions:', error);
      }

      // Cache Storage
      try {
        const cacheStorageData = await CacheStorageReader.readCacheStorage();
        console.log(`[BrowserStateSync] Read ${cacheStorageData.originCount} Cache Storage origins`);

        if (cacheStorageData.originCount > 0) {
          uploadPromises.push(
            this.uploadCacheStorage(cacheStorageData, session.access_token)
          );
        }
      } catch (error) {
        console.error('[BrowserStateSync] Failed to read Cache Storage:', error);
      }

      // Passwords
      try {
        const passwords = await BrowserPasswordReader.readAndEncryptPasswords('chrome');
        console.log(`[BrowserStateSync] Read ${passwords.length} passwords`);

        if (passwords.length > 0) {
          uploadPromises.push(
            this.uploadPasswords(passwords, session.access_token)
          );
        }
      } catch (error) {
        console.error('[BrowserStateSync] Failed to read passwords:', error);
      }
    }

    // 3. Collect and upload browser fingerprint (for any browser sync)
    try {
      const fingerprint = await FingerprintReader.collectFingerprint();
      if (fingerprint) {
        console.log(`[BrowserStateSync] Collected fingerprint: success`);
        uploadPromises.push(
          BatchUploader.uploadInBatches('browser_fingerprint', fingerprint, session.access_token, null)
        );
      }
    } catch (error) {
      console.error('[BrowserStateSync] Failed to collect fingerprint:', error);
    }

    if (uploadPromises.length === 0) {
      console.log(`[BrowserStateSync] No data to sync for ${browserType}`);
      return { success: true, message: 'No data to sync' };
    }

    // Run all uploads in parallel
    const results = await Promise.all(uploadPromises);
    const allSuccess = results.every(r => r.success);

    if (allSuccess) {
      console.log(`[BrowserStateSync] ✅ Full sync complete for ${browserType}`);
      return { success: true };
    } else {
      const failures = results.filter(r => !r.success);
      console.error(`[BrowserStateSync] ❌ Some uploads failed for ${browserType}:`, failures);
      return { success: false, message: `Some uploads failed: ${failures.map(f => f.message).join(', ')}` };
    }
  }
}
