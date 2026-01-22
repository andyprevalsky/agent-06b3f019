import { config } from '../base/config';
import { AuthService } from './auth';
import { BrowserCookieReader } from './browserCookieReader';
import { LocalStorageReader, LocalStorageData } from './localStorageReader';
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
   * Sync all browser state (cookies + localStorage) to the backend.
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

      // Find all connected browser cookie integrations
      const connectedBrowserTypes = integrations
        .filter(i => i.name.endsWith('_cookies') && i.status === 'CONNECTED')
        .map(i => i.name.replace('_cookies', ''));

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
              BatchUploader.uploadInBatches(`${browser.type}_cookies`, cookies, session.access_token, null)
            );
          }
        } catch (error) {
          console.error(`[BrowserStateSync] Failed to read ${browser.name} cookies:`, error);
        }
      }

      // Read and upload localStorage (always from Chrome path for now)
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
}
