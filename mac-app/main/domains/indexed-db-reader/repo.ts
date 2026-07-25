/**
 * Repo layer for indexed-db-reader.
 *
 * Owns the one Electron boundary the domain still needs: `app.getPath('home')`,
 * used to locate the user's Chrome profile. All LevelDB / blob file IO lives in
 * the `./native` modules (which read the filesystem directly), and the decoding
 * is pure TypeScript — there is no longer any Python subprocess.
 */

import { app } from 'electron';

/** Return the user's home directory — the root under which Chrome stores data. */
export function resolveHomeDir(): string {
  return app.getPath('home');
}
