/**
 * Service layer for contacts-reader-native.
 *
 * Orchestrates the full CNContactStore scan:
 *   1. Consult the in-memory cache (TTL-bounded, reset on `forceRefresh`).
 *   2. Pull raw `MacContact[]` from the native addon (repo).
 *   3. Optionally dump every raw contact to disk for debugging (repo, gated
 *      by `CONTACT_DUMP_ENV_VAR`; any fs failure is swallowed so the scan
 *      still completes).
 *   4. Normalize each `MacContact` into our canonical `ContactRecord`
 *      (missing strings → `""`, missing optionals → `undefined`, phones
 *      rewritten to E.164, emails trimmed with empties filtered).
 *   5. Index every record under its identifier, every phone (normalized +
 *      raw-trimmed), and every lowercased email — first write wins so the
 *      identifier-keyed entry stays authoritative.
 *   6. Log a 5-contact sample for operator visibility (dedup by identifier
 *      or by `first-last-firstPhone` when identifier is missing).
 *
 * All filesystem / native-addon boundaries go through repo.ts. This file is
 * pure logic: phone parsing, cache management, map construction, lookup.
 */

import type { MacContact } from 'node-mac-contacts';
import {
  CACHE_TTL_MS,
  CONTACT_DUMP_ENABLED_VALUE,
  CONTACT_DUMP_ENV_VAR,
  CONTACT_OPTIONAL_PROPERTIES,
  LOG_COMPONENT,
  SAMPLE_LOG_MAX,
} from './config';
import { dumpContactsToDisk, readAllContacts, readAuthStatus } from './repo';
import type { ContactRecord } from './types';

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

/**
 * Module-level cache + load timestamp. Shared across every call in the
 * process — the runtime layer's static-class wrapper does not introduce a
 * second cache. Exported for test-only reset via the runtime's static
 * fields (the blackbox seam pokes through the class).
 */
interface CacheState {
  map: Map<string, ContactRecord> | null;
  lastLoadedAt: number;
}

const cache: CacheState = {
  map: null,
  lastLoadedAt: 0,
};

/** Reset the module-level cache. Used by the runtime-layer test seam. */
export function resetCache(): void {
  cache.map = null;
  cache.lastLoadedAt = 0;
}

/** True when the cache has a value and the TTL hasn't expired. */
function isCacheFresh(now: number): boolean {
  return cache.map !== null && now - cache.lastLoadedAt < CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// Phone / identifier normalization
// ---------------------------------------------------------------------------

/**
 * Rewrite a raw phone string to E.164.
 *   - strips all non-digits
 *   - drops a leading "1" from 11-digit US numbers
 *   - prefixes 10-digit results with "+1"
 *   - otherwise ensures a leading "+"
 * An input with no digits falls back to the trimmed original.
 */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits === '') return phone.trim();

  let normalized = digits;
  if (normalized.length === 11 && normalized.startsWith('1')) {
    normalized = normalized.slice(1);
  }

  if (normalized.length === 10) {
    normalized = `+1${normalized}`;
  } else if (!normalized.startsWith('+')) {
    normalized = `+${normalized}`;
  }

  return normalized;
}

/**
 * Classify an identifier. Emails (contain `@`) are lower-cased; everything
 * else is treated as a phone number and routed through `normalizePhone`.
 */
function normalizeIdentifier(identifier: string): string {
  if (identifier.includes('@')) {
    return identifier.trim().toLowerCase();
  }
  return normalizePhone(identifier);
}

// ---------------------------------------------------------------------------
// Record construction + indexing
// ---------------------------------------------------------------------------

/** Coerce a possibly-missing string to `""` (matches `X || ''` for any falsy). */
function emptyIfBlank(value: string | undefined | null): string {
  return value !== undefined && value !== null && value !== '' ? value : '';
}

/** Collapse a possibly-missing string to `undefined` when blank. */
function undefinedIfBlank(value: string | undefined | null): string | undefined {
  return value !== undefined && value !== null && value !== '' ? value : undefined;
}

/**
 * Project a raw `MacContact` into our canonical `ContactRecord`. Missing
 * strings collapse to `""`, missing optionals collapse to `undefined`,
 * phones are normalized, and empty/whitespace emails are filtered out.
 */
function buildRecord(contact: MacContact): ContactRecord {
  const phones = contact.phoneNumbers ?? [];
  const emails = contact.emailAddresses ?? [];
  return {
    identifier: contact.identifier,
    firstName: emptyIfBlank(contact.firstName),
    lastName: emptyIfBlank(contact.lastName),
    middleName: undefinedIfBlank(contact.middleName),
    nickname: undefinedIfBlank(contact.nickname),
    company: undefinedIfBlank(contact.organizationName),
    jobTitle: undefinedIfBlank(contact.jobTitle),
    department: undefinedIfBlank(contact.departmentName),
    phoneNumbers: phones
      .filter((phone): phone is string => typeof phone === 'string' && phone !== '')
      .map((phone) => normalizePhone(phone)),
    emails: emails
      .filter((email): email is string => typeof email === 'string' && email !== '')
      .map((email) => email.trim())
      .filter((email) => email !== ''),
  };
}

/**
 * Index a record under every lookup key we support: identifier, both
 * normalized and raw-trimmed phone variants, and lowercased email. First
 * write wins so the canonical identifier entry is authoritative.
 */
function addRecordToMap(map: Map<string, ContactRecord>, record: ContactRecord): void {
  const register = (key: string) => {
    if (key === '') return;
    if (!map.has(key)) {
      map.set(key, record);
    }
  };

  register(record.identifier);

  for (const phone of record.phoneNumbers) {
    register(normalizePhone(phone));
    register(phone.trim());
  }

  for (const email of record.emails) {
    register(email.toLowerCase());
  }
}

// ---------------------------------------------------------------------------
// Debug dump (gated)
// ---------------------------------------------------------------------------

/**
 * Write every raw contact to disk when `CONTACT_DUMP_ENV_VAR` is set to the
 * enabled sentinel. Failures are caught and logged — the dump is purely for
 * debugging and must never fail the scan.
 */
function maybeDumpContacts(contacts: MacContact[]): void {
  if (process.env[CONTACT_DUMP_ENV_VAR] !== CONTACT_DUMP_ENABLED_VALUE) {
    return;
  }
  try {
    const dumpPath = dumpContactsToDisk(contacts);
    console.log(`[${LOG_COMPONENT}] Dumped all contact objects (one per row) to ${dumpPath}`);
  } catch (err) {
    console.warn(`[${LOG_COMPONENT}] Failed to dump contacts to text file:`, err);
  }
}

// ---------------------------------------------------------------------------
// Sample logging
// ---------------------------------------------------------------------------

/** Coerce a possibly-empty string to a visible placeholder for logs. */
function fallback(value: string | undefined, placeholder: string): string {
  return value !== undefined && value !== '' ? value : placeholder;
}

/** Log up to `SAMPLE_LOG_MAX` deduped sample records for operator visibility. */
function logSample(map: Map<string, ContactRecord>): void {
  const samples: ContactRecord[] = [];
  const seen = new Set<string>();
  for (const record of map.values()) {
    const firstPhone = record.phoneNumbers[0] ?? '';
    const key =
      record.identifier !== ''
        ? record.identifier
        : `${record.firstName}-${record.lastName}-${firstPhone}`;
    if (seen.has(key)) continue;
    seen.add(key);
    samples.push(record);
    if (samples.length >= SAMPLE_LOG_MAX) break;
  }

  if (samples.length === 0) return;

  console.log(`[${LOG_COMPONENT}] 📋 Sample contacts:`);
  samples.forEach((record, index) => {
    console.log(
      `  #${index + 1}: id=${fallback(record.identifier, 'n/a')} name="${record.firstName} ${record.lastName}". phones=${
        record.phoneNumbers.length
      } emails=${record.emails.length} company=${fallback(record.company, 'n/a')}`
    );
  });
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Read every contact from CNContactStore, normalized + indexed. Consults
 * the TTL cache unless `forceRefresh` is set. Native exceptions propagate.
 */
export async function readContacts(forceRefresh = false): Promise<Map<string, ContactRecord>> {
  if (!forceRefresh && isCacheFresh(Date.now()) && cache.map !== null) {
    return cache.map;
  }

  try {
    console.log(`[${LOG_COMPONENT}] 🔍 Loading contacts via node-mac-contacts...`);
    const authStatus = readAuthStatus();
    if (authStatus !== undefined && authStatus !== '') {
      console.log(`[${LOG_COMPONENT}] Contacts permission status: ${authStatus}`);
    }

    const contacts = readAllContacts(CONTACT_OPTIONAL_PROPERTIES);
    maybeDumpContacts(contacts);
    console.log(`[${LOG_COMPONENT}] Retrieved ${contacts.length} contacts from CNContactStore`);

    const map = new Map<string, ContactRecord>();
    let contactsWithPhones = 0;
    let contactsWithEmails = 0;

    for (const contact of contacts) {
      const record = buildRecord(contact);
      if (record.phoneNumbers.length > 0) contactsWithPhones++;
      if (record.emails.length > 0) contactsWithEmails++;
      addRecordToMap(map, record);
    }

    console.log(
      `[${LOG_COMPONENT}] Indexed ${map.size} identifiers (${contactsWithPhones} contacts with phones, ${contactsWithEmails} with emails)`
    );

    logSample(map);

    cache.map = map;
    cache.lastLoadedAt = Date.now();
    return map;
  } catch (error) {
    console.error(`[${LOG_COMPONENT}] ❌ Failed to load contacts:`, error);
    throw error;
  }
}

/**
 * Resolve an identifier (phone / email / raw) against a previously-loaded
 * map. Trims whitespace, tries normalized → lowercased-trimmed → raw-trimmed.
 * Returns `undefined` when the identifier is empty or the key is unknown.
 */
export function lookupContact(
  identifier: string,
  contactMap: Map<string, ContactRecord>
): ContactRecord | undefined {
  if (identifier === '') return undefined;

  const trimmed = identifier.trim();
  const normalized = normalizeIdentifier(trimmed);

  return (
    contactMap.get(normalized) ?? contactMap.get(trimmed.toLowerCase()) ?? contactMap.get(trimmed)
  );
}
