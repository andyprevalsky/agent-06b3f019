/**
 * messaging-core domain blackbox
 *
 * Surface under test:
 *   - main/services/messaging/MessageTransformer.ts   (pure coordinator: NormalizedMessage[] -> ContactWithMessages[])
 *   - main/services/messaging/types.ts               (channel + message shapes)
 *   - main/services/messaging/index.ts               (public barrel)
 *   - main/services/uploader.ts                      (platform-aware fetch boundary: /api/integrations/{imessage,whatsapp,telegram}/upload)
 *
 * This file deliberately scopes to the observable behavior of messaging-core:
 *   - Transform NormalizedMessage batches from every platform (IMESSAGE / WHATSAPP / TELEGRAM)
 *     into the ContactWithMessages shape the backend expects.
 *   - Verify the barrel public API remains stable.
 *   - Capture the exact outbound fetch the transformer output produces when handed to
 *     the Uploader (the only fetch boundary the messaging pipeline crosses).
 *
 * Scope deferrals (per batch prompt):
 *   - flake×5 reruns, concurrent invocations, negative-control checks, broader-suite verification.
 *   - Full Sync coordinators (WhatsAppSync/TelegramSync). They are singleton static classes that
 *     wrap platform clients (Baileys/GramJS) + AuthService + IntegrationCache + BatchUploader.
 *     Characterizing them requires deep mocking of modules outside messaging-core's ownership;
 *     we instead test the observable fetch boundary their buffers eventually reach (via Uploader).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubAllElectron } from './electron-stubs';
import { fetchCaptures, clearFetchCaptures, installFetchCapture } from './fetch-capture';
import { MessageTransformer } from '../../main/services/messaging/MessageTransformer';
import type { NormalizedMessage, MessageChannel } from '../../main/services/messaging/types';

// Env must exist BEFORE ../../main/base/config is evaluated (Uploader pulls it in transitively).
process.env.VITE_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.VITE_BACKEND_API_URL ??= 'http://localhost:3001';

stubAllElectron();

// telegram/sessions is imported at module-eval time by TelegramAuth.
// Stub so the barrel import doesn't reach into the real telegram SDK.
vi.mock('telegram', () => ({
  TelegramClient: vi.fn(),
  Api: {},
}));
vi.mock('telegram/sessions', () => ({
  StringSession: vi.fn().mockImplementation((s: string) => ({ save: () => s ?? '' })),
}));
vi.mock('telegram/events', () => ({
  NewMessage: vi.fn(),
}));
vi.mock('telegram/tl', () => ({
  Api: {},
}));
// Baileys is dynamic-imported inside WhatsAppClient, but give it a static stub too in case.
vi.mock('@whiskeysockets/baileys', () => ({
  default: {},
  makeWASocket: vi.fn(),
  useMultiFileAuthState: vi.fn(),
}));

/**
 * Factory: build a NormalizedMessage for a specific channel with sensible defaults.
 */
function makeMsg(
  channel: MessageChannel,
  overrides: Partial<NormalizedMessage> = {}
): NormalizedMessage {
  const base: NormalizedMessage = {
    id: '1',
    text: 'hello',
    timestamp: new Date('2024-01-01T00:00:00Z'),
    isFromMe: false,
    chatId: 'chat-1',
    contactId: 'contact-1',
    contactName: 'Alice',
    channel,
    contact: { firstName: 'Alice' },
  };
  return { ...base, ...overrides };
}

describe('messaging-core > MessageTransformer.toContactWithMessages', () => {
  it('IMESSAGE happy path: groups by contactId, sorts ascending, and converts timestamp to Apple-epoch ns', async () => {
    const later = new Date('2024-02-01T00:00:00Z');
    const earlier = new Date('2024-01-01T00:00:00Z');

    const out = MessageTransformer.toContactWithMessages([
      makeMsg('IMESSAGE', { id: '2', timestamp: later, text: 'second' }),
      makeMsg('IMESSAGE', { id: '1', timestamp: earlier, text: 'first' }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].contact_id).toBe('contact-1');
    expect(out[0].contact_name).toBe('Alice');
    expect(out[0].firstName).toBe('Alice');
    expect(out[0].messages.map((m) => m.id)).toEqual(['1', '2']);
    expect(out[0].messages.map((m) => m.text)).toEqual(['first', 'second']);

    // Apple epoch offset = 978307200 sec between 1970 and 2001.
    const APPLE = 978307200;
    const expectedEarlierNs = (Math.floor(earlier.getTime() / 1000) - APPLE) * 1_000_000_000;
    expect(out[0].messages[0].date).toBe(expectedEarlierNs);
    expect(out[0].messages[0].contactHandle).toBe('contact-1');
  });

  it('WHATSAPP happy path: uses ms-since-epoch and preserves is_from_me', async () => {
    const ts = new Date('2024-03-10T12:34:56Z');
    const out = MessageTransformer.toContactWithMessages([
      makeMsg('WHATSAPP', { isFromMe: true, timestamp: ts }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].messages[0].date).toBe(ts.getTime());
    expect(out[0].messages[0].is_from_me).toBe(true);
  });

  it('TELEGRAM happy path: uses ms-since-epoch and carries contact enrichment', async () => {
    const ts = new Date('2024-03-10T12:34:56Z');
    const out = MessageTransformer.toContactWithMessages([
      makeMsg('TELEGRAM', {
        timestamp: ts,
        contact: {
          firstName: 'Bob',
          lastName: 'Builder',
          company: 'Acme',
          title: 'Eng',
          email: 'bob@acme.test',
          emailAddresses: ['bob@acme.test', 'b@acme.test'],
        },
      }),
    ]);

    expect(out[0].firstName).toBe('Bob');
    expect(out[0].lastName).toBe('Builder');
    expect(out[0].company).toBe('Acme');
    expect(out[0].title).toBe('Eng');
    expect(out[0].email).toBe('bob@acme.test');
    expect(out[0].emailAddresses).toEqual(['bob@acme.test', 'b@acme.test']);
    expect(out[0].messages[0].date).toBe(ts.getTime());
  });

  it('merges contact enrichment from later messages without overwriting earlier values', async () => {
    const out = MessageTransformer.toContactWithMessages([
      makeMsg('WHATSAPP', {
        id: '1',
        contactName: undefined,
        contact: { firstName: 'Alice' },
      }),
      makeMsg('WHATSAPP', {
        id: '2',
        contactName: 'Alice Wonderland',
        contact: { firstName: 'WRONG', lastName: 'Wonderland', company: 'Tea Co' },
      }),
    ]);

    expect(out).toHaveLength(1);
    // firstName stays 'Alice' (first truthy wins); lastName is filled in from msg #2.
    expect(out[0].firstName).toBe('Alice');
    expect(out[0].lastName).toBe('Wonderland');
    expect(out[0].company).toBe('Tea Co');
    // contact_name was previously undefined → msg #2 fills it in.
    expect(out[0].contact_name).toBe('Alice Wonderland');
  });

  it('splits multiple contacts into separate ContactWithMessages entries', async () => {
    const out = MessageTransformer.toContactWithMessages([
      makeMsg('IMESSAGE', { contactId: 'a', id: '1' }),
      makeMsg('IMESSAGE', { contactId: 'b', id: '2' }),
      makeMsg('IMESSAGE', { contactId: 'a', id: '3' }),
    ]);

    expect(out).toHaveLength(2);
    const byId = Object.fromEntries(out.map((c) => [c.contact_id, c]));
    expect(byId.a.messages.map((m) => m.id).sort()).toEqual(['1', '3']);
    expect(byId.b.messages.map((m) => m.id)).toEqual(['2']);
  });

  it('empty state: no messages → empty array (no-op)', async () => {
    expect(MessageTransformer.toContactWithMessages([])).toEqual([]);
  });

  it('error/boundary state: missing contactName falls back to null (not undefined)', async () => {
    const out = MessageTransformer.toContactWithMessages([
      makeMsg('IMESSAGE', { contactName: undefined, contact: undefined }),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0].contact_name).toBeNull();
    // no enrichment fields leak through when contact is undefined
    expect(out[0].firstName).toBeUndefined();
    expect(out[0].lastName).toBeUndefined();
  });
});

describe('messaging-core > MessageTransformer.getStats', () => {
  it('counts messages per channel, per direction, and unique contacts', async () => {
    const stats = MessageTransformer.getStats([
      makeMsg('IMESSAGE', { contactId: 'a', isFromMe: true }),
      makeMsg('IMESSAGE', { contactId: 'a', isFromMe: false }),
      makeMsg('WHATSAPP', { contactId: 'b', isFromMe: false }),
      makeMsg('TELEGRAM', { contactId: 'c', isFromMe: true }),
    ]);

    expect(stats.total).toBe(4);
    expect(stats.fromUser).toBe(2);
    expect(stats.fromOthers).toBe(2);
    expect(stats.uniqueContacts).toBe(3);
    expect(stats.byChannel).toEqual({ IMESSAGE: 2, WHATSAPP: 1, TELEGRAM: 1 });
  });

  it('empty input returns zeroed stats across all channels (no-op)', async () => {
    const stats = MessageTransformer.getStats([]);
    expect(stats).toEqual({
      total: 0,
      fromUser: 0,
      fromOthers: 0,
      uniqueContacts: 0,
      byChannel: { IMESSAGE: 0, WHATSAPP: 0, TELEGRAM: 0 },
    });
  });
});

describe('messaging-core > public barrel', () => {
  it('re-exports MessageTransformer from main/services/messaging', async () => {
    const mod = await import('../../main/services/messaging');
    expect(typeof mod.MessageTransformer.toContactWithMessages).toBe('function');
    expect(typeof mod.MessageTransformer.getStats).toBe('function');
  });

  it('re-exports platform classes (imessage/whatsapp/telegram)', async () => {
    const mod = await import('../../main/services/messaging');
    expect(typeof mod.IMessageWatcher).toBe('function');
    expect(typeof mod.WhatsAppAuth).toBe('function');
    expect(typeof mod.WhatsAppClient).toBe('function');
    expect(typeof mod.WhatsAppSync).toBe('function');
    expect(typeof mod.TelegramAuth).toBe('function');
    expect(typeof mod.TelegramClient).toBe('function');
    expect(typeof mod.TelegramSync).toBe('function');
  });
});

/**
 * Fetch boundary: the only fetch the messaging pipeline makes is via Uploader (called by
 * BatchUploader, called by {WhatsApp,Telegram}Sync.flushBuffer / iMessage handler). We capture
 * each platform's outbound request shape using installFetchCapture + a fake ContactWithMessages
 * payload produced by MessageTransformer.
 *
 * Note on iMessage: Uploader.buildIMessagePayload re-wraps ContactWithMessages into
 * IMessageUploadPayload (it detects the already-structured shape). Other platforms pass through.
 */
describe('messaging-core > Uploader fetch boundary', () => {
  let restore: (() => void) | null = null;

  beforeEach(() => {
    clearFetchCaptures();
  });

  afterEach(() => {
    if (restore) {
      restore();
      restore = null;
    }
  });

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  async function loadUploader() {
    const { Uploader } = await import('../../main/services/uploader');
    return Uploader;
  }

  it('WHATSAPP: POSTs transformer output to /api/integrations/whatsapp/upload with bearer auth and JSON body', async () => {
    const Uploader = await loadUploader();

    restore = installFetchCapture({
      '/api/integrations/whatsapp/upload': () => jsonResponse({ ok: true }),
    });

    const contacts = MessageTransformer.toContactWithMessages([
      makeMsg('WHATSAPP', { id: 'w1', text: 'hi' }),
    ]);

    const result = await Uploader.uploadData('whatsapp', contacts, 'tok-whatsapp', null);

    expect(result.success).toBe(true);
    expect(fetchCaptures).toHaveLength(1);
    const call = fetchCaptures[0];
    expect(call.url).toBe('http://localhost:3001/api/integrations/whatsapp/upload');
    expect(call.method).toBe('POST');
    expect(call.headers['authorization']).toBe('Bearer tok-whatsapp');
    expect(call.headers['content-type']).toBe('application/json');
    const body = JSON.parse(call.body ?? '{}');
    expect(Array.isArray(body.contacts)).toBe(true);
    expect(body.contacts[0].contact_id).toBe('contact-1');
    expect(body.contacts[0].messages[0].text).toBe('hi');
    expect(typeof body.accessedAt).toBe('string');
  });

  it('TELEGRAM: POSTs transformer output to /api/integrations/telegram/upload with bearer auth and JSON body', async () => {
    const Uploader = await loadUploader();

    restore = installFetchCapture({
      '/api/integrations/telegram/upload': () => jsonResponse({ ok: true }),
    });

    const contacts = MessageTransformer.toContactWithMessages([
      makeMsg('TELEGRAM', { id: 't1', text: 'hey' }),
    ]);

    const result = await Uploader.uploadData('telegram', contacts, 'tok-telegram', null);

    expect(result.success).toBe(true);
    expect(fetchCaptures).toHaveLength(1);
    const call = fetchCaptures[0];
    expect(call.url).toBe('http://localhost:3001/api/integrations/telegram/upload');
    expect(call.method).toBe('POST');
    expect(call.headers['authorization']).toBe('Bearer tok-telegram');
    expect(call.headers['content-type']).toBe('application/json');
    const body = JSON.parse(call.body ?? '{}');
    expect(body.contacts[0].messages[0].text).toBe('hey');
    expect(typeof body.accessedAt).toBe('string');
  });

  it('IMESSAGE: POSTs to /api/integrations/imessage/upload, wrapping ContactWithMessages as { contacts, accessedAt }', async () => {
    const Uploader = await loadUploader();

    restore = installFetchCapture({
      '/api/integrations/imessage/upload': () => jsonResponse({ ok: true }),
    });

    const contacts = MessageTransformer.toContactWithMessages([
      makeMsg('IMESSAGE', { id: '1', text: 'yo' }),
    ]);

    const result = await Uploader.uploadData('imessage', contacts, 'tok-imsg', null);

    expect(result.success).toBe(true);
    expect(fetchCaptures).toHaveLength(1);
    const call = fetchCaptures[0];
    expect(call.url).toBe('http://localhost:3001/api/integrations/imessage/upload');
    expect(call.method).toBe('POST');
    expect(call.headers['authorization']).toBe('Bearer tok-imsg');
    expect(call.headers['content-type']).toBe('application/json');
    const body = JSON.parse(call.body ?? '{}');
    expect(Array.isArray(body.contacts)).toBe(true);
    expect(body.contacts[0].contact_id).toBe('contact-1');
    expect(typeof body.accessedAt).toBe('string');
  });

  it('error state: upload endpoint returns non-2xx → Uploader returns {success:false} without throwing', async () => {
    const Uploader = await loadUploader();

    restore = installFetchCapture({
      '/api/integrations/whatsapp/upload': () => jsonResponse({ error: 'nope' }, 500),
    });

    const contacts = MessageTransformer.toContactWithMessages([makeMsg('WHATSAPP')]);
    const result = await Uploader.uploadData('whatsapp', contacts, 'tok', null);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Upload failed/);
    // Boundary still captured — contract assertions hold regardless of response status.
    expect(fetchCaptures).toHaveLength(1);
    expect(fetchCaptures[0].url).toContain('/api/integrations/whatsapp/upload');
  });

  it('empty state: empty contact list still POSTs with {contacts:[], accessedAt}', async () => {
    const Uploader = await loadUploader();

    restore = installFetchCapture({
      '/api/integrations/telegram/upload': () => jsonResponse({ ok: true }),
    });

    const empty = MessageTransformer.toContactWithMessages([]);
    expect(empty).toEqual([]);

    const result = await Uploader.uploadData('telegram', empty, 'tok', null);

    expect(result.success).toBe(true);
    expect(fetchCaptures).toHaveLength(1);
    const body = JSON.parse(fetchCaptures[0].body ?? '{}');
    expect(body.contacts).toEqual([]);
    expect(typeof body.accessedAt).toBe('string');
  });
});
