/**
 * Configuration constants for the contacts-reader-native domain.
 *
 * All tunables live here — log prefix, cache TTL, the `OptionalProperty` set
 * we request from `node-mac-contacts`, the env flag that gates the debug
 * dump, and the dump's target filename + file mode.
 */

import type { OptionalProperty } from 'node-mac-contacts';

/** Log prefix used for all domain console output. */
export const LOG_COMPONENT = 'ContactsReaderNative';

/** In-memory cache lifetime. A second scan inside this window reuses the Map. */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * The exact `OptionalProperty` list requested from `node-mac-contacts`. Kept as
 * a constant so the blackbox test can assert the call shape — changing this
 * list changes the native payload we pull out of `CNContactStore`.
 */
export const CONTACT_OPTIONAL_PROPERTIES: OptionalProperty[] = [
  'jobTitle',
  'departmentName',
  'organizationName',
  'middleName',
];

/** Env flag that enables the PII debug dump. Opt-in; never on by default. */
export const CONTACT_DUMP_ENV_VAR = 'ROSE_DEBUG_CONTACT_DUMP';
export const CONTACT_DUMP_ENABLED_VALUE = '1';

/** Filename and mode used when writing the debug dump (mode 0o600 — PII). */
export const CONTACT_DUMP_FILENAME = 'contacts_dump.txt';
export const CONTACT_DUMP_FILE_MODE = 0o600;
export const CONTACT_DUMP_ENCODING = 'utf-8' as const;

/** Max sample contacts logged at the end of a scan. */
export const SAMPLE_LOG_MAX = 5;
