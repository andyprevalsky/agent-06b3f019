/**
 * Blackbox tests for indexed-db-reader config.
 *
 * SCRIPT_PATH is resolved at module load from Electron packaging state:
 *   dev  -> repo-local scripts/read_indexeddb.py
 *   prod -> process.resourcesPath/scripts/read_indexeddb.py
 */

import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadConfig(isPackaged: boolean) {
  vi.resetModules();
  vi.doMock('electron', () => ({
    app: {
      isPackaged,
      getAppPath: () => path.join(__dirname, '..', '..'),
    },
  }));
  return import('../../main/domains/indexed-db-reader/config');
}

describe('indexed-db-reader config blackbox', () => {
  const originalResourcesPath = process.resourcesPath;

  afterEach(() => {
    vi.doUnmock('electron');
    vi.resetModules();
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: originalResourcesPath,
    });
  });

  it('uses the repo-local helper script path in development', async () => {
    const config = await loadConfig(false);

    expect(config.SCRIPT_PATH).toBe(
      path.join(__dirname, '..', '..', 'scripts', 'read_indexeddb.py')
    );
  });

  it('uses the bundled resources helper script path when packaged', async () => {
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: '/Applications/Rose.app/Contents/Resources',
    });

    const config = await loadConfig(true);

    expect(config.SCRIPT_PATH).toBe(
      '/Applications/Rose.app/Contents/Resources/scripts/read_indexeddb.py'
    );
  });
});
