import { spawn } from 'child_process';
import path from 'path';
import crypto from 'crypto';
import { app } from 'electron';

export interface IndexedDBRecord {
  key: string | number | (string | number)[];
  value: unknown;
  error?: string;
}

export interface IndexedDBObjectStore {
  name: string;
  records: IndexedDBRecord[];
}

export interface IndexedDBDatabase {
  name: string;
  objectStores: IndexedDBObjectStore[];
}

export interface IndexedDBOriginData {
  origin: string;
  databases: IndexedDBDatabase[];
  error?: string;
}

export interface IndexedDBData {
  origins: IndexedDBOriginData[];
  hashes: Record<string, string>; // origin -> hash
}

/**
 * Compute a hash of IndexedDB data for an origin.
 * Used for cache invalidation.
 */
function computeOriginHash(data: IndexedDBOriginData): string {
  const content = JSON.stringify(data.databases);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * IndexedDBReader reads Chrome's IndexedDB via a Python script.
 *
 * Chrome stores IndexedDB in a LevelDB format with a custom comparator
 * that standard Node.js LevelDB libraries can't read. We use the
 * ccl_chromium_reader Python library which handles this correctly.
 */
export class IndexedDBReader {
  // In dev mode, __dirname is dist/main/main/services, so we need to go up 4 levels to get to mac-app root
  // In prod mode, the script should be bundled alongside the app
  private static scriptPath = path.join(__dirname, '../../../../scripts/read_indexeddb.py');

  /**
   * Read IndexedDB data for origins matching the filter.
   * @param originFilter - Optional filter string (e.g., "amazon" to get Amazon origins)
   */
  static async readIndexedDB(originFilter?: string): Promise<IndexedDBData> {
    return new Promise((resolve) => {
      const args = originFilter ? [this.scriptPath, originFilter] : [this.scriptPath];

      console.log(
        `[IndexedDBReader] Reading IndexedDB${originFilter ? ` for '${originFilter}'` : ''}...`
      );

      const python = spawn('python3', args, {
        cwd: app.getPath('home'),
      });

      let stdout = '';
      let stderr = '';

      python.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      python.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      python.on('close', (code) => {
        if (code !== 0) {
          // Code 1 with no stderr usually means no matching origins found - not an error
          if (code === 1 && !stderr.trim()) {
            console.log(
              `[IndexedDBReader] No IndexedDB data found${originFilter ? ` for '${originFilter}'` : ''}`
            );
          } else {
            console.error(`[IndexedDBReader] Python script failed with code ${code}`);
            if (stderr.trim()) {
              console.error(`[IndexedDBReader] stderr: ${stderr}`);
            }
          }
          resolve({ origins: [], hashes: {} });
          return;
        }

        try {
          const results: IndexedDBOriginData[] = JSON.parse(stdout);

          // Check for errors
          if (results.length === 1 && results[0].error) {
            console.error(`[IndexedDBReader] Error: ${results[0].error}`);
            resolve({ origins: [], hashes: {} });
            return;
          }

          // Compute hashes for each origin
          const hashes: Record<string, string> = {};
          for (const origin of results) {
            if (!origin.error) {
              hashes[origin.origin] = computeOriginHash(origin);
            }
          }

          const totalDatabases = results.reduce((sum, o) => sum + (o.databases?.length || 0), 0);
          const totalRecords = results.reduce(
            (sum, o) =>
              sum +
              (o.databases?.reduce(
                (s, d) =>
                  s + (d.objectStores?.reduce((r, os) => r + (os.records?.length || 0), 0) || 0),
                0
              ) || 0),
            0
          );

          console.log(
            `[IndexedDBReader] Read ${results.length} origins, ${totalDatabases} databases, ${totalRecords} records`
          );

          resolve({ origins: results, hashes });
        } catch (error) {
          console.error(`[IndexedDBReader] Failed to parse output: ${error}`);
          console.error(`[IndexedDBReader] stdout: ${stdout.slice(0, 500)}`);
          resolve({ origins: [], hashes: {} });
        }
      });

      python.on('error', (error) => {
        console.error(`[IndexedDBReader] Failed to spawn Python: ${error}`);
        resolve({ origins: [], hashes: {} });
      });
    });
  }
}
