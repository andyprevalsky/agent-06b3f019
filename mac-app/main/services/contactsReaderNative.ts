/**
 * Legacy entry path for the contacts-reader-native domain.
 *
 * The implementation lives in `main/domains/contacts-reader-native/`; this
 * shim preserves the pre-refactor import path for callers (i-message-reader
 * repo, blackbox tests) without forcing them to update their imports.
 *
 * New code should import from 'main/domains/contacts-reader-native/runtime'.
 */

export { ContactsReaderNative } from '../domains/contacts-reader-native/runtime';
export type { ContactRecord } from '../domains/contacts-reader-native/runtime';
