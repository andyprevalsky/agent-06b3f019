/**
 * Repo layer for contacts-reader-native.
 *
 * Owns every system boundary the domain touches:
 *   - `node-mac-contacts` (reading CNContactStore + permission status)
 *   - `fs.writeFileSync` (the opt-in PII debug dump)
 *   - `path.join` + `process.cwd()` (where the dump lands)
 *
 * Service layer never imports `node-mac-contacts` or `fs` directly — it goes
 * through these named, typed functions. Each is safe to stub in blackbox
 * tests; the suite mocks `node-mac-contacts` and `fs` exactly at these seams.
 */

import fs from 'fs';
import path from 'path';
import type { MacContact, OptionalProperty } from 'node-mac-contacts';
import * as macContactsModule from 'node-mac-contacts';
import { CONTACT_DUMP_ENCODING, CONTACT_DUMP_FILE_MODE, CONTACT_DUMP_FILENAME } from './config';

/**
 * Narrow the dynamically-imported `node-mac-contacts` namespace to the exact
 * two entry points we use. `getAuthStatus` is optional at runtime — older
 * builds of the native addon ship without it.
 */
const macContacts = macContactsModule as unknown as {
  getAllContacts: (props?: OptionalProperty[]) => MacContact[];
  getAuthStatus?: () => string;
};

/**
 * Read the current CNContactStore permission status if the native addon
 * exposes `getAuthStatus()`. Returns `undefined` when the addon doesn't ship
 * that entry point; callers treat that as "skip the permission log".
 */
export function readAuthStatus(): string | undefined {
  return macContacts.getAuthStatus?.();
}

/**
 * Read every contact from the native address book with the given optional
 * property set. Returns `[]` when the addon yields a nullish result (matches
 * the pre-refactor `|| []` behavior so a revoked-permissions state is an
 * empty scan, not a crash).
 */
export function readAllContacts(props: OptionalProperty[]): MacContact[] {
  // The native addon can yield `null` on revoked permissions even though the
  // TS type says `MacContact[]` — cast and coalesce explicitly so a null
  // return becomes an empty scan instead of a crash later in the pipeline.
  const result = macContacts.getAllContacts(props) as MacContact[] | null | undefined;
  return result ?? [];
}

/**
 * Write the raw contact objects (one JSON-serialized row per line) to a
 * mode-0600 file under `process.cwd()`. PII — gated by
 * `CONTACT_DUMP_ENV_VAR`; the caller enforces that gate. Returns the final
 * on-disk path so the caller can log it.
 */
export function dumpContactsToDisk(contacts: MacContact[]): string {
  const dumpPath = path.join(process.cwd(), CONTACT_DUMP_FILENAME);
  const lines = contacts.map((contact) => JSON.stringify(contact));
  fs.writeFileSync(dumpPath, lines.join('\n'), {
    encoding: CONTACT_DUMP_ENCODING,
    mode: CONTACT_DUMP_FILE_MODE,
  });
  return dumpPath;
}
