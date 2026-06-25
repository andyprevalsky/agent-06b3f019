/**
 * Configuration constants for the indexed-db-reader domain.
 *
 * Houses the Python binary name, the bundled helper-script location, and the
 * short-hash length used for per-origin change detection.
 */

import path from 'path';
import { app } from 'electron';

/** Log prefix used for every domain console line. */
export const LOG_COMPONENT = 'IndexedDBReader';

/** Interpreter we spawn for the bundled LevelDB reader. */
export const PYTHON_BIN = 'python3';

/** Length of the sha256 prefix used as a per-origin change-detection hash. */
export const ORIGIN_HASH_PREFIX_LENGTH = 16;

/**
 * Absolute path of the bundled Python helper that reads Chrome's IndexedDB.
 *
 * Chrome stores IndexedDB in a LevelDB format with a custom comparator that
 * standard Node.js LevelDB libraries can't read. We use the
 * `ccl_chromium_reader` Python library which handles it correctly.
 *
 * In dev mode `__dirname` is `dist/main/main/domains/indexed-db-reader`; going
 * up five levels lands at `mac-app/`, where `scripts/read_indexeddb.py` lives.
 * In prod the script is bundled outside `app.asar` at
 * `Contents/Resources/scripts/read_indexeddb.py` so Python can execute it.
 */
export const SCRIPT_PATH =
  app.isPackaged === true
    ? path.join(process.resourcesPath, 'scripts', 'read_indexeddb.py')
    : path.join(__dirname, '..', '..', '..', '..', '..', 'scripts', 'read_indexeddb.py');
