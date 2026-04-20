/**
 * Runtime layer for contacts-reader-native.
 *
 * Exposes the static `ContactsReaderNative` class that existing callers
 * (i-message-reader repo, blackbox tests) already import. Keeps the public
 * surface identical to the pre-refactor flat file so wiring and mocks don't
 * need to change.
 *
 * Responsibilities:
 *   - Delegate `readContacts` / `lookupContact` to the service layer.
 *   - Expose `cache` / `lastLoadedAt` as a write-only test seam — the
 *     blackbox suite assigns `null` / `0` between specs to clear the TTL
 *     cache. Any assignment forwards to `service.resetCache()`; the raw
 *     value is discarded because the service owns the canonical state.
 */

import * as service from './service';
import type { ContactRecord } from './types';

export type { ContactRecord } from './types';

export class ContactsReaderNative {
  /** Test-seam: assigning any value clears the service-owned TTL cache. */
  static set cache(_value: Map<string, ContactRecord> | null) {
    service.resetCache();
  }

  /** Test-seam: assigning any value clears the service-owned TTL cache. */
  static set lastLoadedAt(_value: number) {
    service.resetCache();
  }

  /**
   * Read every contact from CNContactStore, normalized + indexed. Consults
   * the TTL cache unless `forceRefresh` is set. Native exceptions propagate.
   */
  static async readContacts(forceRefresh = false): Promise<Map<string, ContactRecord>> {
    return service.readContacts(forceRefresh);
  }

  /**
   * Resolve an identifier (phone / email / raw) against a previously-loaded
   * map. Returns `undefined` when the identifier is empty or unknown.
   */
  static lookupContact(
    identifier: string,
    contactMap: Map<string, ContactRecord>
  ): ContactRecord | undefined {
    return service.lookupContact(identifier, contactMap);
  }
}
