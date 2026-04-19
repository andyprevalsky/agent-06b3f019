/**
 * contacts-reader-native domain blackbox
 *
 * Surface under test:
 *   - main/services/contactsReaderNative.ts (ContactsReaderNative.readContacts / lookupContact)
 *
 * Observable behavior exercised here:
 *   - readContacts() calls node-mac-contacts.getAllContacts() with the hardcoded
 *     OptionalProperty list (['jobTitle','departmentName','organizationName','middleName']).
 *   - Native-module throw propagates to the caller (no swallowed error).
 *   - Empty contact list yields an empty Map.
 *   - Happy path maps MacContact shape → ContactRecord, indexes by identifier + all
 *     phone variants (raw + normalized +1...) + lowercased email.
 *   - Phone normalization: 10-digit → "+1XXXXXXXXXX", 11-digit starting with "1" → "+1...",
 *     already-E.164 preserved.
 *   - undefined/null MacContact fields coerced to "" or undefined per ContactRecord shape.
 *   - File-dump side effect writes contacts_dump.txt with one JSON row per contact.
 *   - Dump fs failure is caught and does not abort the read.
 *   - In-memory cache: second call within CACHE_TTL_MS skips the native call.
 *   - forceRefresh=true bypasses the cache.
 *   - lookupContact() resolves identifiers via normalized phone OR lowercased email OR raw.
 *   - getAuthStatus() is called when available (permission surface visible but not a gate).
 *   - Zero outbound HTTP calls (fetch-capture invariant).
 *
 * Boundary capture: N/A for HTTP — this domain makes zero outbound fetch calls.
 * The only system boundaries are the `node-mac-contacts` native addon and the local
 * filesystem (`fs.writeFileSync` for the debug dump). Both are stubbed. fetchCaptures
 * is still asserted empty as a hard invariant.
 *
 * Scope deferrals (per batch prompt):
 *   - flake×5 reruns, concurrent invocations, negative-control checks, broader-suite verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchCaptures, clearFetchCaptures, installFetchCapture } from './fetch-capture';

// ── Mock node-mac-contacts at the module boundary ────────────────────────────
// The module imports both a namespace (`import * as macContactsModule`) and a type-
// only import. We provide a factory that exposes both `default` and named exports
// so either import style resolves to the same spies.
const getAllContactsMock = vi.hoisted(() => vi.fn());
const getAuthStatusMock = vi.hoisted(() => vi.fn(() => 'Authorized'));
vi.mock('node-mac-contacts', () => ({
  __esModule: true,
  getAllContacts: getAllContactsMock,
  getAuthStatus: getAuthStatusMock,
  default: {
    getAllContacts: getAllContactsMock,
    getAuthStatus: getAuthStatusMock,
  },
}));

// ── Mock fs — readContacts() dumps every contact to contacts_dump.txt ───────
const fsWriteFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('fs', () => ({
  default: { writeFileSync: fsWriteFileSyncMock },
  writeFileSync: fsWriteFileSyncMock,
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

interface MacContactFixture {
  identifier: string;
  firstName?: string;
  lastName?: string;
  middleName?: string;
  nickname?: string;
  organizationName?: string;
  jobTitle?: string;
  departmentName?: string;
  phoneNumbers?: string[];
  emailAddresses?: string[];
}

function makeMacContact(overrides: Partial<MacContactFixture> = {}): MacContactFixture {
  return {
    identifier: 'ABC-123',
    firstName: 'Ada',
    lastName: 'Lovelace',
    organizationName: 'Analytical Engine Co',
    jobTitle: 'Mathematician',
    departmentName: 'Research',
    phoneNumbers: ['+14155551234'],
    emailAddresses: ['ada@example.com'],
    ...overrides,
  };
}

/**
 * Reset the static cache on the class so successive tests don't leak state.
 * The class uses a private static Map cache + timestamp — we reach in via the
 * module's exported symbol and null them out between tests.
 */
async function resetModuleCache(): Promise<void> {
  const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ContactsReaderNative as any).cache = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ContactsReaderNative as any).lastLoadedAt = 0;
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe('contacts-reader-native blackbox', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(async () => {
    clearFetchCaptures();
    getAllContactsMock.mockReset();
    getAuthStatusMock.mockReset();
    getAuthStatusMock.mockReturnValue('Authorized');
    fsWriteFileSyncMock.mockReset();
    await resetModuleCache();
    restoreFetch = installFetchCapture({});
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  describe('auth boundary', () => {
    it('still invokes getAllContacts when permission is Denied (logs status, no gate)', async () => {
      // The current implementation logs the auth status but does not short-circuit
      // on 'Denied' — it delegates to getAllContacts which returns [] in that case.
      getAuthStatusMock.mockReturnValue('Denied');
      getAllContactsMock.mockReturnValue([]);
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      const result = await ContactsReaderNative.readContacts();

      expect(result.size).toBe(0);
      expect(getAuthStatusMock).toHaveBeenCalledTimes(1);
      expect(getAllContactsMock).toHaveBeenCalledTimes(1);
      expect(fetchCaptures).toHaveLength(0);
    });

    it('does not throw when getAuthStatus returns a falsy value', async () => {
      // Optional-chain path: when getAuthStatus returns '' (falsy), the reader
      // skips the "Contacts permission status" log branch entirely.
      getAuthStatusMock.mockReturnValue('');
      getAllContactsMock.mockReturnValue([makeMacContact({ identifier: 'falsy-auth' })]);
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      const result = await ContactsReaderNative.readContacts();
      expect(result.get('falsy-auth')).toBeDefined();
    });
  });

  describe('happy path', () => {
    it('maps MacContact fields → ContactRecord and indexes by identifier, phone variants, and email', async () => {
      getAllContactsMock.mockReturnValue([
        makeMacContact({
          identifier: 'ID-1',
          firstName: 'Ada',
          lastName: 'Lovelace',
          phoneNumbers: ['+14155551234'],
          emailAddresses: ['Ada@Example.com'],
        }),
      ]);
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      const result = await ContactsReaderNative.readContacts();

      // Indexed under identifier + normalized phone + raw phone + lowercased email.
      expect(result.get('ID-1')).toBeDefined();
      expect(result.get('+14155551234')).toBeDefined();
      expect(result.get('ada@example.com')).toBeDefined();

      const record = result.get('ID-1')!;
      expect(record).toMatchObject({
        identifier: 'ID-1',
        firstName: 'Ada',
        lastName: 'Lovelace',
        company: 'Analytical Engine Co',
        jobTitle: 'Mathematician',
        department: 'Research',
        phoneNumbers: ['+14155551234'],
        emails: ['Ada@Example.com'],
      });
    });

    it('passes the hardcoded OptionalProperty list to the native addon', async () => {
      getAllContactsMock.mockReturnValue([]);
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      await ContactsReaderNative.readContacts();

      expect(getAllContactsMock).toHaveBeenCalledWith([
        'jobTitle',
        'departmentName',
        'organizationName',
        'middleName',
      ]);
    });

    it('coerces missing firstName/lastName to empty strings and missing optionals to undefined', async () => {
      getAllContactsMock.mockReturnValue([
        {
          identifier: 'bare-id',
          // firstName/lastName absent
          phoneNumbers: ['+14155559999'],
          emailAddresses: [],
        },
      ]);
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      const result = await ContactsReaderNative.readContacts();
      const record = result.get('bare-id')!;

      expect(record.firstName).toBe('');
      expect(record.lastName).toBe('');
      expect(record.company).toBeUndefined();
      expect(record.jobTitle).toBeUndefined();
      expect(record.department).toBeUndefined();
      expect(record.middleName).toBeUndefined();
      expect(record.nickname).toBeUndefined();
    });

    it('filters falsy phone/email entries before mapping', async () => {
      getAllContactsMock.mockReturnValue([
        makeMacContact({
          identifier: 'filter-id',
          phoneNumbers: ['+14155551111', '', '+14155552222'],
          emailAddresses: ['keep@example.com', '', '  '],
        }),
      ]);
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      const result = await ContactsReaderNative.readContacts();
      const record = result.get('filter-id')!;

      expect(record.phoneNumbers).toEqual(['+14155551111', '+14155552222']);
      expect(record.emails).toEqual(['keep@example.com']);
    });
  });

  describe('phone normalization', () => {
    it('prefixes 10-digit US numbers with +1', async () => {
      getAllContactsMock.mockReturnValue([
        makeMacContact({ identifier: 'P10', phoneNumbers: ['4155551234'], emailAddresses: [] }),
      ]);
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      const result = await ContactsReaderNative.readContacts();
      // Indexed under the normalized +1 form.
      expect(result.get('+14155551234')).toBeDefined();
      expect(result.get('+14155551234')!.phoneNumbers).toEqual(['+14155551234']);
    });

    it('strips leading "1" from 11-digit numbers and re-prefixes with +1', async () => {
      getAllContactsMock.mockReturnValue([
        makeMacContact({ identifier: 'P11', phoneNumbers: ['14155551234'], emailAddresses: [] }),
      ]);
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      const result = await ContactsReaderNative.readContacts();
      expect(result.get('+14155551234')).toBeDefined();
    });

    it('preserves already-E.164 numbers with formatting', async () => {
      getAllContactsMock.mockReturnValue([
        makeMacContact({
          identifier: 'P-fmt',
          phoneNumbers: ['(415) 555-1234'],
          emailAddresses: [],
        }),
      ]);
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      const result = await ContactsReaderNative.readContacts();
      // Digits-only → 4155551234 → +14155551234.
      expect(result.get('+14155551234')).toBeDefined();
    });
  });

  describe('empty state', () => {
    it('returns an empty Map when the native addon returns []', async () => {
      getAllContactsMock.mockReturnValue([]);
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      const result = await ContactsReaderNative.readContacts();

      expect(result.size).toBe(0);
      expect(fetchCaptures).toHaveLength(0);
    });

    it('tolerates the native addon returning null/undefined', async () => {
      // Reader falls back to [] via `|| []` when the addon yields a nullish result.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getAllContactsMock.mockReturnValue(null as any);
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      const result = await ContactsReaderNative.readContacts();
      expect(result.size).toBe(0);
    });
  });

  describe('error state', () => {
    it('propagates native getAllContacts exceptions to the caller', async () => {
      getAllContactsMock.mockImplementation(() => {
        throw new Error('CNContactStore permission revoked');
      });
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      await expect(ContactsReaderNative.readContacts()).rejects.toThrow(
        /CNContactStore permission revoked/
      );
      expect(fetchCaptures).toHaveLength(0);
    });

    it('catches fs.writeFileSync failures during the debug dump without aborting the read', async () => {
      getAllContactsMock.mockReturnValue([makeMacContact({ identifier: 'dump-id' })]);
      fsWriteFileSyncMock.mockImplementation(() => {
        throw new Error('EACCES: permission denied writing contacts_dump.txt');
      });
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      const prevFlag = process.env.ROSE_DEBUG_CONTACT_DUMP;
      process.env.ROSE_DEBUG_CONTACT_DUMP = '1';
      try {
        // Should resolve even though the dump threw — error is swallowed by design.
        const result = await ContactsReaderNative.readContacts();
        expect(result.get('dump-id')).toBeDefined();
        expect(fsWriteFileSyncMock).toHaveBeenCalledTimes(1);
      } finally {
        if (prevFlag === undefined) delete process.env.ROSE_DEBUG_CONTACT_DUMP;
        else process.env.ROSE_DEBUG_CONTACT_DUMP = prevFlag;
      }
    });
  });

  describe('debug dump side effect', () => {
    it('writes one JSON-serialized row per contact to contacts_dump.txt (when ROSE_DEBUG_CONTACT_DUMP=1)', async () => {
      const contacts = [
        makeMacContact({ identifier: 'A' }),
        makeMacContact({ identifier: 'B', firstName: 'Grace', lastName: 'Hopper' }),
      ];
      getAllContactsMock.mockReturnValue(contacts);
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      const prevFlag = process.env.ROSE_DEBUG_CONTACT_DUMP;
      process.env.ROSE_DEBUG_CONTACT_DUMP = '1';
      try {
        await ContactsReaderNative.readContacts();

        expect(fsWriteFileSyncMock).toHaveBeenCalledTimes(1);
        const [dumpPath, body, encoding] = fsWriteFileSyncMock.mock.calls[0];
        expect(String(dumpPath)).toMatch(/contacts_dump\.txt$/);
        // writeFileSync is called with an options object `{ encoding, mode }`,
        // not a raw string — PII files must be mode 0o600.
        expect(encoding).toEqual({ encoding: 'utf-8', mode: 0o600 });
        const lines = String(body).split('\n');
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]).identifier).toBe('A');
        expect(JSON.parse(lines[1]).identifier).toBe('B');
      } finally {
        if (prevFlag === undefined) delete process.env.ROSE_DEBUG_CONTACT_DUMP;
        else process.env.ROSE_DEBUG_CONTACT_DUMP = prevFlag;
      }
    });

    it('does NOT write contacts_dump.txt when ROSE_DEBUG_CONTACT_DUMP is unset', async () => {
      getAllContactsMock.mockReturnValue([makeMacContact({ identifier: 'no-dump' })]);
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      const prevFlag = process.env.ROSE_DEBUG_CONTACT_DUMP;
      delete process.env.ROSE_DEBUG_CONTACT_DUMP;
      try {
        await ContactsReaderNative.readContacts();
        expect(fsWriteFileSyncMock).not.toHaveBeenCalled();
      } finally {
        if (prevFlag !== undefined) process.env.ROSE_DEBUG_CONTACT_DUMP = prevFlag;
      }
    });
  });

  describe('cache', () => {
    it('returns the cached Map on successive calls within TTL without hitting the native addon', async () => {
      getAllContactsMock.mockReturnValue([makeMacContact({ identifier: 'cache-id' })]);
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      const first = await ContactsReaderNative.readContacts();
      const second = await ContactsReaderNative.readContacts();

      expect(first).toBe(second); // identity-equal (cached reference)
      expect(getAllContactsMock).toHaveBeenCalledTimes(1);
    });

    it('bypasses the cache when forceRefresh=true', async () => {
      getAllContactsMock.mockReturnValue([makeMacContact({ identifier: 'refresh-id' })]);
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      await ContactsReaderNative.readContacts();
      await ContactsReaderNative.readContacts(true);

      expect(getAllContactsMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('lookupContact', () => {
    it('resolves identifiers via normalized phone', async () => {
      getAllContactsMock.mockReturnValue([
        makeMacContact({
          identifier: 'look-phone',
          phoneNumbers: ['4155551234'],
          emailAddresses: [],
        }),
      ]);
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      const map = await ContactsReaderNative.readContacts();
      // Caller gives a raw digit string — lookup normalizes before Map lookup.
      const found = ContactsReaderNative.lookupContact('4155551234', map);

      expect(found?.identifier).toBe('look-phone');
    });

    it('resolves identifiers via lowercased email', async () => {
      getAllContactsMock.mockReturnValue([
        makeMacContact({
          identifier: 'look-email',
          phoneNumbers: [],
          emailAddresses: ['Mixed@Case.com'],
        }),
      ]);
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      const map = await ContactsReaderNative.readContacts();
      const found = ContactsReaderNative.lookupContact('MIXED@CASE.COM', map);

      expect(found?.identifier).toBe('look-email');
    });

    it('returns undefined for empty identifier or unknown key', async () => {
      getAllContactsMock.mockReturnValue([makeMacContact({ identifier: 'only-id' })]);
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      const map = await ContactsReaderNative.readContacts();

      expect(ContactsReaderNative.lookupContact('', map)).toBeUndefined();
      expect(ContactsReaderNative.lookupContact('missing-key', map)).toBeUndefined();
    });

    it('trims whitespace around the requested identifier', async () => {
      getAllContactsMock.mockReturnValue([
        makeMacContact({
          identifier: 'trim-id',
          phoneNumbers: ['+14155551234'],
          emailAddresses: [],
        }),
      ]);
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      const map = await ContactsReaderNative.readContacts();
      expect(ContactsReaderNative.lookupContact('  +14155551234  ', map)?.identifier).toBe(
        'trim-id'
      );
    });
  });

  describe('boundary invariant (HTTP)', () => {
    it('makes zero outbound HTTP calls during readContacts', async () => {
      getAllContactsMock.mockReturnValue([makeMacContact()]);
      const { ContactsReaderNative } = await import('../../main/services/contactsReaderNative');

      await ContactsReaderNative.readContacts();

      expect(fetchCaptures).toHaveLength(0);
    });
  });
});
