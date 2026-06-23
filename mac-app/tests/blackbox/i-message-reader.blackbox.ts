/**
 * Blackbox tests for the `i-message-reader` domain (main-process service).
 *
 * Entry: main/services/iMessageReader.ts
 * Supporting files:
 *   - main/services/contactsReaderNative.ts  (macOS Contacts boundary)
 *   - main/services/messaging/types.ts       (NormalizedMessage shape)
 *   - shared/types/ipc.ts                    (IMessageData shape)
 *
 * Observable surface we exercise:
 *   - `IMessageReader.checkAccess()`    → boolean gate on ~/Library/Messages/chat.db
 *   - `IMessageReader.readMessages()`   → filtered IMessageData[] (async)
 *   - `IMessageReader.readMessagesSinceRowId()` → incremental fetch (async)
 *   - `IMessageReader.getMaxRowId()`    → highest ROWID or 0 on denied access
 *   - `IMessageReader.toNormalizedMessage(msg)` / `toNormalizedMessages(msgs)`
 *
 * Real-world boundaries (stubbed in tests):
 *   - `better-sqlite3` (chat.db read)
 *   - `node-mac-contacts` (contact enrichment)
 *   - `fs.openSync/closeSync` (access probe — triggers TCC registration)
 *
 * The reader issues NO outbound HTTP calls. We install the shared fetch-capture
 * harness anyway and assert `fetchCaptures` stays empty so future regressions
 * that introduce outbound calls to this service fail loudly.
 *
 * Scope deferrals (documented in PR body, not tested here):
 *   flake×5, concurrent-invocation, negative-control, broader-suite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFetchCapture, clearFetchCaptures, fetchCaptures } from './fetch-capture';
import {
  extractTextFromAttributedBody,
  extractTextFromStreamtyped,
  isLikelyOtpMessage,
  readTypedstreamLength,
} from '../../main/domains/i-message-reader/service.clean';

// Config reads env vars at module-load time for any transitively-imported main modules.
process.env.VITE_SUPABASE_URL = 'https://test.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY = 'test-anon-key';
process.env.VITE_BACKEND_API_URL = 'http://localhost:3001';
process.env.ENCRYPTION_KEY = 'test-encryption-key';

// Inline Electron stub — importing from ./electron-stubs pulls in that file's
// top-level `vi.mock('better-sqlite3', ...)` (hoisted by vitest at import
// time), which pre-empts our own per-test better-sqlite3 mock below. Defining
// the Electron stub inline keeps all mock factories in this file and
// guarantees our better-sqlite3 driver is the one that runs.
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/mac-app-test'),
    getName: vi.fn(() => 'rose-desktop-test'),
    getVersion: vi.fn(() => '0.0.0-test'),
    on: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    isReady: vi.fn(() => true),
    isPackaged: false,
    name: '',
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(s)),
    decryptString: vi.fn((b: Buffer) => b.toString()),
  },
  shell: { openExternal: vi.fn() },
}));

// ── Boundary stubs ─────────────────────────────────────────────────────────

interface RawRow {
  id: number;
  text: string | null;
  date: number;
  is_from_me: number;
  associated_message_text: string | null;
  attributedBody: Buffer | null;
  handle_id: string | null;
  chat_identifier: string | null;
  contact_name: string | null;
}

// `vi.mock` is hoisted to the top of the file, so any state it closes over
// must be initialized via `vi.hoisted` — regular const declarations end up
// `undefined` at factory-evaluation time.
const sqliteState = vi.hoisted(() => ({
  rows: [] as RawRow[],
  historicalReplies: [] as Array<{ handle_id: string }>,
  maxId: 0,
  columns: {
    message: [{ name: 'associated_message_text' }, { name: 'attributedBody' }],
  } as Record<string, Array<{ name: string }>>,
  preparedSql: [] as string[],
  closeCalls: 0,
  throwOnOpen: null as Error | null,
}));

vi.mock('better-sqlite3', () => {
  return {
    default: vi.fn().mockImplementation(() => {
      if (sqliteState.throwOnOpen) throw sqliteState.throwOnOpen;
      return {
        prepare: vi.fn((sql: string) => {
          sqliteState.preparedSql.push(sql);
          const trimmed = sql.trim();
          if (trimmed.startsWith('PRAGMA table_info')) {
            // PRAGMA table_info(message) → column list
            const match = /PRAGMA table_info\((\w+)\)/.exec(trimmed);
            const table = match?.[1] ?? 'message';
            return {
              all: vi.fn(() => sqliteState.columns[table] ?? []),
              get: vi.fn(() => undefined),
              run: vi.fn(() => ({ changes: 0 })),
            };
          }
          if (trimmed.startsWith('SELECT MAX(ROWID)')) {
            return {
              all: vi.fn(() => []),
              get: vi.fn(() => ({ maxId: sqliteState.maxId })),
              run: vi.fn(() => ({ changes: 0 })),
            };
          }
          // Any SELECT that joins handle ON is_from_me = 1 is the
          // historical-replies lookup used in sync mode.
          if (trimmed.includes('is_from_me = 1') && trimmed.includes('handle_id')) {
            return {
              all: vi.fn(() => sqliteState.historicalReplies),
              get: vi.fn(() => undefined),
              run: vi.fn(() => ({ changes: 0 })),
            };
          }
          // Otherwise: the main message SELECT.
          return {
            all: vi.fn(() => sqliteState.rows),
            get: vi.fn(() => undefined),
            run: vi.fn(() => ({ changes: 0 })),
          };
        }),
        exec: vi.fn(),
        close: vi.fn(() => {
          sqliteState.closeCalls += 1;
        }),
        pragma: vi.fn(),
      };
    }),
  };
});

const contactsState = vi.hoisted(() => ({
  getAllContacts: vi.fn(() => [] as unknown[]),
  getAuthStatus: vi.fn(() => 'Authorized'),
  throwOnGetAll: null as Error | null,
}));

vi.mock('node-mac-contacts', () => ({
  getAllContacts: (...args: unknown[]) => {
    if (contactsState.throwOnGetAll) throw contactsState.throwOnGetAll;
    return contactsState.getAllContacts(...args);
  },
  getAuthStatus: () => contactsState.getAuthStatus(),
}));

// bplist-parser returns a well-formed archive with $objects that includes a
// candidate string. The reader's extractTextFromAttributedBody picks the
// longest non-Apple-prefixed string.
vi.mock('bplist-parser', () => ({
  parseBuffer: vi.fn((_buffer: Buffer) => [
    {
      $objects: ['NSAttributedString', 'NSObject', 'decoded attributed body text'],
    },
  ]),
}));

// fs.openSync / closeSync drive the access probe.
const fsState = vi.hoisted(() => ({
  openSync: vi.fn(),
  closeSync: vi.fn(),
  throwOnOpen: null as Error | null,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      openSync: (...args: unknown[]) => {
        if (fsState.throwOnOpen) throw fsState.throwOnOpen;
        fsState.openSync(...args);
        return 42; // file descriptor
      },
      closeSync: (...args: unknown[]) => {
        fsState.closeSync(...args);
      },
      writeFileSync: actual.writeFileSync,
    },
    openSync: (...args: unknown[]) => {
      if (fsState.throwOnOpen) throw fsState.throwOnOpen;
      fsState.openSync(...args);
      return 42;
    },
    closeSync: (...args: unknown[]) => {
      fsState.closeSync(...args);
    },
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────

const APPLE_EPOCH_OFFSET = 978307200; // seconds 1970→2001
function dateToApple(ns: Date): number {
  const unix = Math.floor(ns.getTime() / 1000);
  return (unix - APPLE_EPOCH_OFFSET) * 1_000_000_000;
}

function makeRow(overrides: Partial<RawRow> = {}): RawRow {
  return {
    id: 1,
    text: 'hello there',
    date: dateToApple(new Date('2025-01-15T12:00:00.000Z')),
    is_from_me: 0,
    associated_message_text: null,
    attributedBody: null,
    handle_id: '+15555551212',
    chat_identifier: '+15555551212',
    contact_name: 'Alice Example',
    ...overrides,
  };
}

// Build a minimal `streamtyped` (NSArchiver typedstream) attributedBody blob
// the way modern macOS stores message text: a `streamtyped` header, the class
// chain, then the body NSString introduced by `+` (0x2B) and a typedstream
// length prefix (single byte < 128, else 0x81 + little-endian uint16).
function makeStreamtyped(text: string): Buffer {
  const textBuf = Buffer.from(text, 'utf8');
  const len = textBuf.length;
  const lenBytes =
    len < 0x80 ? Buffer.from([len]) : Buffer.from([0x81, len & 0xff, (len >> 8) & 0xff]);
  return Buffer.concat([
    Buffer.from([0x04, 0x0b]),
    Buffer.from('streamtyped', 'latin1'),
    Buffer.from('NSAttributedString', 'latin1'),
    Buffer.from('NSMutableString', 'latin1'),
    Buffer.from('NSString', 'latin1'),
    Buffer.from([0x2b]),
    lenBytes,
    textBuf,
  ]);
}

function resetSqliteState(): void {
  sqliteState.rows = [];
  sqliteState.historicalReplies = [];
  sqliteState.maxId = 0;
  sqliteState.columns = {
    message: [{ name: 'associated_message_text' }, { name: 'attributedBody' }],
  };
  sqliteState.preparedSql = [];
  sqliteState.closeCalls = 0;
  sqliteState.throwOnOpen = null;
}

function resetContactsState(): void {
  contactsState.getAllContacts.mockReset();
  contactsState.getAllContacts.mockReturnValue([]);
  contactsState.getAuthStatus.mockReset();
  contactsState.getAuthStatus.mockReturnValue('Authorized');
  contactsState.throwOnGetAll = null;
}

function resetFsState(): void {
  fsState.openSync.mockReset();
  fsState.closeSync.mockReset();
  fsState.throwOnOpen = null;
}

// The module-level `columnPresenceCache` inside iMessageReader is module-scoped.
// Tests that toggle column availability rely on a fresh module via resetModules.
async function loadReader(): Promise<typeof import('../../main/services/iMessageReader')> {
  vi.resetModules();
  return import('../../main/services/iMessageReader');
}

// ── Suite ───────────────────────────────────────────────────────────────

describe('blackbox: i-message-reader (main-service)', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    clearFetchCaptures();
    resetSqliteState();
    resetContactsState();
    resetFsState();
    // Install the harness even though the reader makes no fetch calls — we
    // assert that no outbound HTTP is issued by the reader's public surface.
    restoreFetch = installFetchCapture({});
  });

  afterEach(() => {
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }
  });

  // ── Auth boundary ──────────────────────────────────────────────────────

  it('checkAccess: returns true when fs.openSync succeeds', async () => {
    const { IMessageReader } = await loadReader();
    expect(IMessageReader.checkAccess()).toBe(true);
    // Opened the DB path and closed it — TCC registration requires an
    // actual open, not accessSync.
    expect(fsState.openSync).toHaveBeenCalledTimes(1);
    expect(fsState.closeSync).toHaveBeenCalledTimes(1);
    const [openedPath, mode] = fsState.openSync.mock.calls[0];
    expect(String(openedPath)).toContain('Library/Messages/chat.db');
    expect(mode).toBe('r');
  });

  it('checkAccess: returns false when fs.openSync throws EACCES', async () => {
    fsState.throwOnOpen = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const { IMessageReader } = await loadReader();
    expect(IMessageReader.checkAccess()).toBe(false);
    // closeSync must not run when open throws (no fd to close).
    expect(fsState.closeSync).not.toHaveBeenCalled();
  });

  it('readMessages: throws a user-actionable error when access is denied', async () => {
    fsState.throwOnOpen = new Error('denied');
    const { IMessageReader } = await loadReader();
    await expect(IMessageReader.readMessages()).rejects.toThrow(
      /No access to iMessage database.*Full Disk Access/
    );
  });

  it('readMessagesSinceRowId: throws the same access error when denied', async () => {
    fsState.throwOnOpen = new Error('denied');
    const { IMessageReader } = await loadReader();
    await expect(IMessageReader.readMessagesSinceRowId(123)).rejects.toThrow(
      /No access to iMessage database/
    );
  });

  it('getMaxRowId: returns 0 when access is denied (does not throw)', async () => {
    fsState.throwOnOpen = new Error('denied');
    const { IMessageReader } = await loadReader();
    expect(IMessageReader.getMaxRowId()).toBe(0);
  });

  // ── Empty state ────────────────────────────────────────────────────────

  it('empty state: readMessages returns [] and does not touch contacts when no rows', async () => {
    const { IMessageReader } = await loadReader();
    sqliteState.rows = [];
    const messages = await IMessageReader.readMessages();
    expect(messages).toEqual([]);
    // Fast-path: contacts enrichment is skipped when there are 0 rows.
    expect(contactsState.getAllContacts).not.toHaveBeenCalled();
    // DB must be closed even on empty return.
    expect(sqliteState.closeCalls).toBe(1);
  });

  it('empty state: readMessagesSinceRowId returns [] and skips contacts when no new rows', async () => {
    const { IMessageReader } = await loadReader();
    sqliteState.rows = [];
    const messages = await IMessageReader.readMessagesSinceRowId(500);
    expect(messages).toEqual([]);
    expect(contactsState.getAllContacts).not.toHaveBeenCalled();
    expect(sqliteState.closeCalls).toBe(1);
  });

  // ── Happy path ─────────────────────────────────────────────────────────

  it('happy path: readMessages normalizes rows, enriches with contacts, and filters correctly', async () => {
    sqliteState.rows = [
      // Contact user replied to — will be kept
      makeRow({
        id: 1,
        text: 'hey there',
        is_from_me: 0,
        handle_id: '+15555551212',
        contact_name: null,
      }),
      // User's own reply — is_from_me=1 adds handle to repliedHandles
      makeRow({
        id: 2,
        text: 'reply!',
        is_from_me: 1,
        handle_id: '+15555551212',
      }),
      // Orphan message from contact the user never replied to AND no name match
      // → should be filtered out
      makeRow({
        id: 3,
        text: 'orphan',
        is_from_me: 0,
        handle_id: '+15550009999',
        contact_name: null,
      }),
    ];
    contactsState.getAllContacts.mockReturnValue([
      {
        identifier: 'contact-uuid-1',
        firstName: 'Alice',
        lastName: 'Example',
        organizationName: 'Acme',
        jobTitle: 'Engineer',
        phoneNumbers: ['+1 (555) 555-1212'],
        emailAddresses: ['alice@example.com'],
      },
    ]);

    const { IMessageReader } = await loadReader();
    const messages = await IMessageReader.readMessages();

    expect(messages).toHaveLength(2);
    // Both surviving messages belong to +15555551212
    const contactIds = new Set(messages.map((m) => m.contact_id));
    expect(contactIds).toEqual(new Set(['+15555551212']));
    // Contact enrichment populated firstName / lastName / email
    const msg = messages.find((m) => m.id === 1)!;
    expect(msg.contact_firstName).toBe('Alice');
    expect(msg.contact_lastName).toBe('Example');
    expect(msg.contact_name).toBe('Alice Example');
    expect(msg.contact_email).toBe('alice@example.com');
    expect(msg.contact_company).toBe('Acme');
    expect(msg.contact_title).toBe('Engineer');
    expect(msg.contact_emailAddresses).toEqual(['alice@example.com']);
    expect(msg.is_from_me).toBe(false);
  });

  it('happy path: kept-by-name → message from contact with known name is kept even without reply', async () => {
    sqliteState.rows = [
      makeRow({
        id: 10,
        text: 'nice to meet you',
        is_from_me: 0,
        handle_id: '+15551234567',
      }),
    ];
    contactsState.getAllContacts.mockReturnValue([
      {
        identifier: 'c2',
        firstName: 'Bob',
        lastName: 'Smith',
        phoneNumbers: ['+15551234567'],
        emailAddresses: [],
      },
    ]);

    const { IMessageReader } = await loadReader();
    const out = await IMessageReader.readMessages();
    expect(out).toHaveLength(1);
    expect(out[0].contact_name).toBe('Bob Smith');
  });

  it('happy path: isoTimestamp filter is converted to Apple-epoch nanos and appears in SQL', async () => {
    const { IMessageReader } = await loadReader();
    sqliteState.rows = [];
    await IMessageReader.readMessages('2025-01-01T00:00:00.000Z');
    const mainQuery = sqliteState.preparedSql.find((s) => s.includes('FROM message'))!;
    // 2025-01-01 UTC in Apple nanos
    const expected =
      (Math.floor(new Date('2025-01-01T00:00:00.000Z').getTime() / 1000) - APPLE_EPOCH_OFFSET) *
      1_000_000_000;
    expect(mainQuery).toContain(`m.date > ${expected}`);
  });

  it('sync mode (isSync=true): runs the historical-replies query and keeps messages from previously-replied contacts', async () => {
    sqliteState.rows = [
      makeRow({
        id: 20,
        text: 'new incoming',
        is_from_me: 0,
        handle_id: '+15550000001',
      }),
    ];
    // Historical reply lookup returns this handle → message survives filter
    sqliteState.historicalReplies = [{ handle_id: '+15550000001' }];
    contactsState.getAllContacts.mockReturnValue([]);

    const { IMessageReader } = await loadReader();
    const out = await IMessageReader.readMessages(undefined, true);
    expect(out).toHaveLength(1);
    // The historical-replies SELECT must have been issued
    expect(sqliteState.preparedSql.some((s) => s.includes('is_from_me = 1'))).toBe(true);
  });

  // ── Filtering invariants ──────────────────────────────────────────────

  it('skips: short-numeric handles (≤ 8 digits, e.g. shortcodes) are dropped', async () => {
    sqliteState.rows = [
      makeRow({ id: 100, handle_id: '12345', text: 'short code', contact_name: null }),
    ];
    const { IMessageReader } = await loadReader();
    const out = await IMessageReader.readMessages();
    expect(out).toHaveLength(0);
  });

  it('skips: missing handle and chat_identifier → dropped', async () => {
    sqliteState.rows = [
      makeRow({ id: 101, handle_id: null, chat_identifier: null, contact_name: null }),
    ];
    const { IMessageReader } = await loadReader();
    const out = await IMessageReader.readMessages();
    expect(out).toHaveLength(0);
  });

  it('skips: rows whose text/associated/attributed all sanitize to empty → dropped', async () => {
    sqliteState.rows = [
      makeRow({
        id: 102,
        text: '\u0000',
        associated_message_text: null,
        attributedBody: null,
        handle_id: '+15555551212',
      }),
      // Surviving row keeps contact in repliedHandles
      makeRow({ id: 103, is_from_me: 1, text: 'hi', handle_id: '+15555551212' }),
    ];
    const { IMessageReader } = await loadReader();
    const out = await IMessageReader.readMessages();
    // Only the non-empty row remains
    expect(out.map((m) => m.id)).toEqual([103]);
  });

  it('normalizes: email handles lowercased; phone handles preserve "+"', async () => {
    sqliteState.rows = [
      makeRow({ id: 200, handle_id: 'Alice@Example.COM', is_from_me: 0, contact_name: null }),
      makeRow({ id: 201, handle_id: 'Alice@Example.COM', is_from_me: 1, text: 'reply' }),
      makeRow({ id: 202, handle_id: '  +15559998888  ', is_from_me: 0, contact_name: null }),
      makeRow({ id: 203, handle_id: '+15559998888', is_from_me: 1, text: 'reply' }),
    ];
    const { IMessageReader } = await loadReader();
    const out = await IMessageReader.readMessages();
    const ids = new Set(out.map((m) => m.contact_id));
    expect(ids.has('alice@example.com')).toBe(true);
    expect(ids.has('+15559998888')).toBe(true);
  });

  it('SQL columns: prepared statement references the expected read-only columns', async () => {
    sqliteState.rows = [];
    const { IMessageReader } = await loadReader();
    await IMessageReader.readMessages();
    const mainQuery = sqliteState.preparedSql.find((s) => s.includes('FROM message'));
    expect(mainQuery).toBeTruthy();
    // Business columns the backend depends on:
    expect(mainQuery).toContain('m.ROWID as id');
    expect(mainQuery).toContain('m.text');
    expect(mainQuery).toContain('m.is_from_me');
    expect(mainQuery).toContain('LEFT JOIN handle h');
    expect(mainQuery).toContain('LEFT JOIN chat c');
    // Group-chat filter: chat_identifier NOT LIKE 'chat%' (or NULL) — excluding
    // iMessage group threads from the 1-on-1 sync.
    expect(mainQuery).toContain("c.chat_identifier NOT LIKE 'chat%'");
  });

  it('column-presence fallback: missing attributedBody column → SQL substitutes NULL', async () => {
    // Only expose associated_message_text, not attributedBody
    sqliteState.columns = { message: [{ name: 'associated_message_text' }] };
    sqliteState.rows = [];
    const { IMessageReader } = await loadReader();
    await IMessageReader.readMessages();
    const mainQuery = sqliteState.preparedSql.find((s) => s.includes('FROM message'))!;
    expect(mainQuery).toContain('NULL as attributedBody');
    expect(mainQuery).toContain('m.associated_message_text');
  });

  // ── attributedBody: streamtyped decoding ──────────────────────────────

  it('attributedBody: decodes a streamtyped NSArchiver body to plaintext (not raw binary)', async () => {
    sqliteState.rows = [
      makeRow({
        id: 700,
        text: null,
        associated_message_text: null,
        attributedBody: makeStreamtyped('Your Amazon verification code is 123456'),
        handle_id: '+15555551212',
      }),
    ];
    const { IMessageReader } = await loadReader();
    // Real-time path applies no reply/name filter — exercises cleanRow directly.
    const out = await IMessageReader.readMessagesSinceRowId(699);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('123456');
    // The raw archive markers must NOT leak into the stored text.
    expect(out[0].text).not.toMatch(/streamtyped|NSString|NSAttributedString/);
  });

  it('attributedBody: decodes a streamtyped body using the 16-bit (0x81) length prefix', async () => {
    const longText = `Your one-time passcode is 445566. ${'x'.repeat(200)}`;
    sqliteState.rows = [
      makeRow({
        id: 720,
        text: null,
        associated_message_text: null,
        attributedBody: makeStreamtyped(longText),
        handle_id: '+15555551212',
      }),
    ];
    const { IMessageReader } = await loadReader();
    const out = await IMessageReader.readMessagesSinceRowId(719);
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('445566');
  });

  // ── OTP short codes ────────────────────────────────────────────────────

  it('shortcode OTP: retains a verification text from a numeric short code', async () => {
    sqliteState.rows = [
      makeRow({
        id: 701,
        handle_id: '262966',
        chat_identifier: '262966',
        contact_name: null,
        text: 'Your Amazon OTP is 123456. Do not share it.',
      }),
    ];
    const { IMessageReader } = await loadReader();
    const out = await IMessageReader.readMessagesSinceRowId(700);
    expect(out).toHaveLength(1);
    expect(out[0].contact_id).toBe('262966');
    expect(out[0].text).toContain('123456');
  });

  it('shortcode non-OTP: still drops a marketing text from a short code', async () => {
    sqliteState.rows = [
      makeRow({
        id: 702,
        handle_id: '88888',
        chat_identifier: '88888',
        contact_name: null,
        text: 'Flash sale! 20% off today only — shop now',
      }),
    ];
    const { IMessageReader } = await loadReader();
    const out = await IMessageReader.readMessagesSinceRowId(701);
    expect(out).toHaveLength(0);
  });

  it('readMessages: keeps an OTP text even from a never-replied, unnamed sender', async () => {
    sqliteState.rows = [
      makeRow({
        id: 710,
        handle_id: '+18005551234',
        chat_identifier: '+18005551234',
        is_from_me: 0,
        contact_name: null,
        text: 'Your verification code is 998877',
      }),
    ];
    contactsState.getAllContacts.mockReturnValue([]);
    const { IMessageReader } = await loadReader();
    const out = await IMessageReader.readMessages();
    // Without the OTP exemption this would be filtered as "never replied".
    expect(out.map((m) => m.id)).toContain(710);
  });

  // ── Error state ────────────────────────────────────────────────────────

  it('error state: contacts enrichment throws → readMessages still returns messages without enrichment', async () => {
    sqliteState.rows = [
      makeRow({ id: 1, handle_id: '+15555551212', is_from_me: 0 }),
      makeRow({ id: 2, handle_id: '+15555551212', is_from_me: 1, text: 'reply' }),
    ];
    contactsState.throwOnGetAll = new Error('CN authorization denied');

    const { IMessageReader } = await loadReader();
    // Must not reject — enrichment is best-effort
    const out = await IMessageReader.readMessages();
    expect(out).toHaveLength(2);
    // contactInfo is undefined → firstName/lastName/email null
    for (const m of out) {
      expect(m.contact_firstName ?? null).toBeNull();
      expect(m.contact_lastName ?? null).toBeNull();
      expect(m.contact_email ?? null).toBeNull();
    }
  });

  it('error state: opening the SQLite DB throws → readMessages rejects and leaves DB not-closed', async () => {
    sqliteState.throwOnOpen = new Error('database is locked');
    const { IMessageReader } = await loadReader();
    await expect(IMessageReader.readMessages()).rejects.toThrow(/database is locked/);
  });

  it('cleanup: DB is always closed after readMessages (finally)', async () => {
    sqliteState.rows = [makeRow({ id: 1, handle_id: '+15555551212', is_from_me: 1, text: 'hi' })];
    const { IMessageReader } = await loadReader();
    await IMessageReader.readMessages();
    expect(sqliteState.closeCalls).toBe(1);
  });

  // ── readMessagesSinceRowId (real-time sync) ───────────────────────────

  it('readMessagesSinceRowId: parameterizes the WHERE ROWID > ? clause', async () => {
    sqliteState.rows = [
      makeRow({ id: 500, handle_id: '+15555551212', is_from_me: 1, text: 'ping' }),
    ];
    const { IMessageReader } = await loadReader();
    const out = await IMessageReader.readMessagesSinceRowId(499);
    expect(out).toHaveLength(1);
    const mainQuery = sqliteState.preparedSql.find(
      (s) => s.includes('FROM message') && s.includes('m.ROWID > ?')
    );
    expect(mainQuery).toBeTruthy();
    // ORDER BY date ASC for chronological real-time delivery (vs DESC in readMessages)
    expect(mainQuery).toContain('ORDER BY m.date ASC');
  });

  // ── getMaxRowId ────────────────────────────────────────────────────────

  it('getMaxRowId: returns the SELECT MAX(ROWID) result', async () => {
    sqliteState.maxId = 987654;
    const { IMessageReader } = await loadReader();
    expect(IMessageReader.getMaxRowId()).toBe(987654);
    // DB must be closed
    expect(sqliteState.closeCalls).toBe(1);
  });

  it('getMaxRowId: returns 0 when table is empty (no MAX row)', async () => {
    sqliteState.maxId = 0;
    const { IMessageReader } = await loadReader();
    expect(IMessageReader.getMaxRowId()).toBe(0);
  });

  // ── toNormalizedMessage / toNormalizedMessages ────────────────────────

  it('toNormalizedMessage: maps IMessageData → NormalizedMessage with channel=IMESSAGE', async () => {
    const { IMessageReader } = await loadReader();
    const input = {
      id: 42,
      text: 'hello',
      date: dateToApple(new Date('2025-01-15T12:00:00.000Z')),
      is_from_me: true,
      contact_id: '+15555551212',
      contact_name: 'Alice',
      contact_firstName: 'Alice',
      contact_lastName: 'Smith',
      contact_email: 'alice@example.com',
      contact_company: 'Acme',
      contact_title: 'Eng',
      contact_emailAddresses: ['alice@example.com'],
    };
    const norm = IMessageReader.toNormalizedMessage(input);
    expect(norm).toMatchObject({
      id: '42',
      text: 'hello',
      isFromMe: true,
      chatId: '+15555551212',
      contactId: '+15555551212',
      contactName: 'Alice',
      channel: 'IMESSAGE',
      contact: {
        firstName: 'Alice',
        lastName: 'Smith',
        company: 'Acme',
        title: 'Eng',
        email: 'alice@example.com',
        emailAddresses: ['alice@example.com'],
      },
    });
    expect(norm.timestamp).toBeInstanceOf(Date);
    expect(norm.timestamp.toISOString()).toBe('2025-01-15T12:00:00.000Z');
  });

  it('toNormalizedMessages: maps an array preserving length and order', async () => {
    const { IMessageReader } = await loadReader();
    const out = IMessageReader.toNormalizedMessages([
      {
        id: 1,
        text: 'a',
        date: 0,
        is_from_me: false,
        contact_id: 'x',
        contact_name: null,
        contact_emailAddresses: [],
      },
      {
        id: 2,
        text: 'b',
        date: 0,
        is_from_me: false,
        contact_id: 'y',
        contact_name: null,
        contact_emailAddresses: [],
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.id)).toEqual(['1', '2']);
    expect(out.every((m) => m.channel === 'IMESSAGE')).toBe(true);
  });

  // ── Fetch-capture boundary assertion ───────────────────────────────────

  it('boundary: reader issues zero outbound HTTP calls across its full public surface', async () => {
    sqliteState.rows = [makeRow({ id: 1, handle_id: '+15555551212', is_from_me: 1, text: 'hi' })];
    sqliteState.maxId = 1;
    const { IMessageReader } = await loadReader();

    expect(IMessageReader.checkAccess()).toBe(true);
    await IMessageReader.readMessages();
    await IMessageReader.readMessagesSinceRowId(0);
    expect(IMessageReader.getMaxRowId()).toBe(1);
    IMessageReader.toNormalizedMessages([]);

    // The reader never calls fetch — this is the boundary contract.
    expect(fetchCaptures).toHaveLength(0);
  });
});

// ── service.clean pure helpers: attributedBody decoding + OTP detection ─────

describe('i-message-reader: service.clean attributedBody + OTP helpers', () => {
  describe('readTypedstreamLength', () => {
    it('reads a single-byte length (< 0x80)', () => {
      expect(readTypedstreamLength(Buffer.from([0x05]), 0)).toEqual({ length: 5, next: 1 });
    });
    it('reads a 0x81 marker as a little-endian uint16', () => {
      expect(readTypedstreamLength(Buffer.from([0x81, 0xc8, 0x00]), 0)).toEqual({
        length: 200,
        next: 3,
      });
    });
    it('reads a 0x82 marker as a little-endian uint32', () => {
      expect(readTypedstreamLength(Buffer.from([0x82, 0x00, 0x00, 0x01, 0x00]), 0)).toEqual({
        length: 65536,
        next: 5,
      });
    });
    it('rejects an out-of-range marker byte (>= 0x80, not 0x81/0x82)', () => {
      expect(readTypedstreamLength(Buffer.from([0x90]), 0)).toBeNull();
    });
    it('returns null when the offset is past the end', () => {
      expect(readTypedstreamLength(Buffer.from([0x05]), 5)).toBeNull();
    });
    it('returns null on a truncated 0x81 / 0x82 length', () => {
      expect(readTypedstreamLength(Buffer.from([0x81, 0x01]), 0)).toBeNull();
      expect(readTypedstreamLength(Buffer.from([0x82, 0x01]), 0)).toBeNull();
    });
  });

  describe('extractTextFromStreamtyped', () => {
    const body = (cls: string, text: string): Buffer => {
      const t = Buffer.from(text, 'utf8');
      return Buffer.concat([Buffer.from(cls, 'latin1'), Buffer.from([0x2b, t.length]), t]);
    };
    it('decodes the body after an NSString marker', () => {
      expect(extractTextFromStreamtyped(body('NSString', 'hello world'))).toBe('hello world');
    });
    it('falls back to an NSMutableString marker', () => {
      expect(extractTextFromStreamtyped(body('NSMutableString', 'mutable body'))).toBe(
        'mutable body'
      );
    });
    it('returns null when no class marker is present', () => {
      expect(extractTextFromStreamtyped(Buffer.from('nothing here', 'latin1'))).toBeNull();
    });
    it("returns null when there is no '+' body marker", () => {
      expect(extractTextFromStreamtyped(Buffer.from('NSString and more', 'latin1'))).toBeNull();
    });
    it('returns null when the declared length runs past the buffer', () => {
      const buf = Buffer.concat([Buffer.from('NSString', 'latin1'), Buffer.from([0x2b, 0x50])]);
      expect(extractTextFromStreamtyped(buf)).toBeNull();
    });
    it('returns null on a zero-length body', () => {
      const buf = Buffer.concat([Buffer.from('NSString', 'latin1'), Buffer.from([0x2b, 0x00])]);
      expect(extractTextFromStreamtyped(buf)).toBeNull();
    });
  });

  describe('extractTextFromAttributedBody', () => {
    it('returns null for null / empty buffers', () => {
      expect(extractTextFromAttributedBody(null)).toBeNull();
      expect(extractTextFromAttributedBody(undefined)).toBeNull();
      expect(extractTextFromAttributedBody(Buffer.alloc(0))).toBeNull();
    });
    it('decodes a streamtyped buffer', () => {
      const t = Buffer.from('Your code is 246810', 'utf8');
      const buf = Buffer.concat([
        Buffer.from([0x04, 0x0b]),
        Buffer.from('streamtyped', 'latin1'),
        Buffer.from('NSString', 'latin1'),
        Buffer.from([0x2b, t.length]),
        t,
      ]);
      expect(extractTextFromAttributedBody(buf)).toContain('246810');
    });
    it('decodes a bplist buffer via the plist parser', () => {
      // bplist-parser is mocked to return an archive with a candidate string.
      const buf = Buffer.concat([Buffer.from('bplist00', 'latin1'), Buffer.alloc(8)]);
      expect(extractTextFromAttributedBody(buf)).toBe('decoded attributed body text');
    });
    it('falls back to a plain UTF-8 string for non-archive buffers', () => {
      expect(extractTextFromAttributedBody(Buffer.from('just plain text', 'utf8'))).toBe(
        'just plain text'
      );
    });
  });

  describe('isLikelyOtpMessage', () => {
    it('is true for a digit run plus OTP context', () => {
      expect(isLikelyOtpMessage('Your verification code is 123456')).toBe(true);
      expect(isLikelyOtpMessage('G-445566 is your Google code')).toBe(true);
      expect(isLikelyOtpMessage('Your one-time passcode is 998877. Do not share it.')).toBe(true);
    });
    it('is false when there is no 4-8 digit run', () => {
      expect(isLikelyOtpMessage('your verification code is on its way')).toBe(false);
    });
    it('is false when there is no OTP keyword', () => {
      expect(isLikelyOtpMessage('see you at 12345 Main Street at 7pm')).toBe(false);
    });
  });
});
