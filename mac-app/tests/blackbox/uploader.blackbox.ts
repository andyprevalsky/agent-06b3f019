import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { stubAllElectron } from './electron-stubs';
import {
  installFetchCapture,
  clearFetchCaptures,
  fetchCaptures,
  type MockResponder,
} from './fetch-capture';
import type {
  IMessageData,
  IMessageUploadContact,
  IMessageUploadPayload,
} from '../../shared/types/ipc';

// Config reads env vars at module-load time — set fakes before any import that
// transitively pulls `main/base/config.ts`.
process.env.VITE_SUPABASE_URL = 'https://test.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY = 'test-anon-key';
process.env.VITE_BACKEND_API_URL = 'http://localhost:3001';
process.env.ENCRYPTION_KEY = 'test-encryption-key';

stubAllElectron();

// Replace the module-level config with deterministic values so assertions on
// the upload URL don't depend on dotenv loading order.
vi.mock('../../main/base/config', () => ({
  config: {
    apiUrl: 'http://localhost:3001',
    supabase: {
      url: 'https://test.supabase.co',
      anonKey: 'test-anon-key',
    },
    encryptionKey: 'test-encryption-key',
    isDev: true,
  },
}));

import { Uploader } from '../../main/services/uploader';

const ACCESS_TOKEN = 'test-access-token-123';
const BASE_URL = 'http://localhost:3001';

const okResponder: MockResponder = () =>
  new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const makeWindow = (): { window: BrowserWindow; sendSpy: ReturnType<typeof vi.fn> } => {
  const sendSpy = vi.fn();
  const window = {
    webContents: { send: sendSpy },
  } as unknown as BrowserWindow;
  return { window, sendSpy };
};

function makeIMessage(overrides: Partial<IMessageData> = {}): IMessageData {
  return {
    id: 1,
    text: 'hello there',
    date: 700000000000000000,
    is_from_me: false,
    contact_id: '+15555551212',
    contact_name: 'Alice Example',
    contact_firstName: 'Alice',
    contact_lastName: 'Example',
    contact_email: null,
    contact_company: null,
    contact_title: null,
    contact_emailAddresses: [],
    ...overrides,
  };
}

describe('uploader blackbox', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    clearFetchCaptures();
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  const install = (pattern: string, responder: MockResponder = okResponder): void => {
    restoreFetch = installFetchCapture({ [pattern]: responder });
  };

  describe('imessage integration', () => {
    it('POSTs JSON to /api/integrations/imessage/upload with grouped contacts', async () => {
      install('/api/integrations/imessage/upload');
      const { window } = makeWindow();

      const messages: IMessageData[] = [
        makeIMessage({ id: 1, contact_id: '+15555551212', text: 'hi' }),
        makeIMessage({
          id: 2,
          contact_id: '+15555551212',
          text: 'follow up',
          is_from_me: true,
        }),
        makeIMessage({
          id: 3,
          contact_id: 'bob@example.com',
          contact_name: 'Bob',
          contact_firstName: 'Bob',
          text: 'email hello',
        }),
      ];

      const result = await Uploader.uploadData('imessage', messages, ACCESS_TOKEN, window);

      expect(result).toEqual({ success: true });
      expect(fetchCaptures).toHaveLength(1);

      const req = fetchCaptures[0];
      expect(req.url).toBe(`${BASE_URL}/api/integrations/imessage/upload`);
      expect(req.method).toBe('POST');
      expect(req.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(req.headers['content-type']).toBe('application/json');
      expect(req.responseStatus).toBe(200);

      const body = JSON.parse(req.body ?? '{}') as IMessageUploadPayload & {
        accessedAt: string;
      };
      expect(body.accessedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(body.contacts).toHaveLength(2);

      const phoneContact = body.contacts.find((c) => c.contact_id === '+15555551212');
      expect(phoneContact).toBeDefined();
      expect(phoneContact?.phoneNumber).toBe('+15555551212');
      expect(phoneContact?.email).toBeNull();
      expect(phoneContact?.messages).toHaveLength(2);
      expect(phoneContact?.messages.map((m) => m.id)).toEqual([1, 2]);

      const emailContact = body.contacts.find((c) => c.contact_id === 'bob@example.com');
      expect(emailContact?.phoneNumber).toBeNull();
      expect(emailContact?.email).toBe('bob@example.com');
      expect(emailContact?.messages).toHaveLength(1);
    });

    it('passes through already-structured contacts without regrouping', async () => {
      install('/api/integrations/imessage/upload');
      const { window } = makeWindow();

      const structured: IMessageUploadContact[] = [
        {
          contact_id: '+15555550000',
          contact_name: 'Pre-Structured',
          phoneNumber: '+15555550000',
          email: null,
          firstName: 'Pre',
          lastName: 'Structured',
          company: null,
          title: null,
          emailAddresses: [],
          messages: [{ id: 99, text: 'already shaped', date: 1, is_from_me: false }],
        },
      ];

      await Uploader.uploadData('imessage', structured, ACCESS_TOKEN, window);

      expect(fetchCaptures).toHaveLength(1);
      const body = JSON.parse(fetchCaptures[0].body ?? '{}') as IMessageUploadPayload;
      expect(body.contacts).toEqual(structured);
    });

    it('emits upload:progress 50 then 100 on the provided window', async () => {
      install('/api/integrations/imessage/upload');
      const { window, sendSpy } = makeWindow();

      await Uploader.uploadData('imessage', [makeIMessage()], ACCESS_TOKEN, window);

      const progressCalls = sendSpy.mock.calls.filter(([channel]) => channel === 'upload:progress');
      expect(progressCalls).toHaveLength(2);
      expect(progressCalls[0][1]).toEqual({ type: 'imessage', percent: 50 });
      expect(progressCalls[1][1]).toEqual({ type: 'imessage', percent: 100 });
    });

    it('empty state: produces an empty contacts array when data is not an array', async () => {
      install('/api/integrations/imessage/upload');
      const { window } = makeWindow();

      const result = await Uploader.uploadData(
        'imessage',
        null as unknown as IMessageData[],
        ACCESS_TOKEN,
        window
      );

      expect(result).toEqual({ success: true });
      expect(fetchCaptures).toHaveLength(1);
      const body = JSON.parse(fetchCaptures[0].body ?? '{}') as IMessageUploadPayload;
      expect(body.contacts).toEqual([]);
    });
  });

  describe('whatsapp integration', () => {
    it('POSTs JSON to /api/integrations/whatsapp/upload with contacts passthrough', async () => {
      install('/api/integrations/whatsapp/upload');
      const { window } = makeWindow();
      const contacts = [{ contact_id: 'wa-1', messages: [{ id: 1, text: 'hi' }] }];

      const result = await Uploader.uploadData('whatsapp', contacts, ACCESS_TOKEN, window);

      expect(result).toEqual({ success: true });
      expect(fetchCaptures).toHaveLength(1);
      const req = fetchCaptures[0];
      expect(req.url).toBe(`${BASE_URL}/api/integrations/whatsapp/upload`);
      expect(req.method).toBe('POST');
      expect(req.headers['content-type']).toBe('application/json');
      expect(req.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);

      const body = JSON.parse(req.body ?? '{}') as {
        contacts: unknown;
        accessedAt: string;
      };
      expect(body.contacts).toEqual(contacts);
      expect(body.accessedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('telegram integration', () => {
    it('POSTs JSON to /api/integrations/telegram/upload with contacts passthrough', async () => {
      install('/api/integrations/telegram/upload');
      const { window } = makeWindow();
      const contacts = [{ contact_id: 'tg-1', messages: [] }];

      await Uploader.uploadData('telegram', contacts, ACCESS_TOKEN, window);

      expect(fetchCaptures).toHaveLength(1);
      const req = fetchCaptures[0];
      expect(req.url).toBe(`${BASE_URL}/api/integrations/telegram/upload`);
      expect(req.method).toBe('POST');
      expect(req.headers['content-type']).toBe('application/json');
      const body = JSON.parse(req.body ?? '{}') as { contacts: unknown };
      expect(body.contacts).toEqual(contacts);
    });
  });

  describe('browser cookie integrations', () => {
    const browsers = [
      'chrome',
      'edge',
      'brave',
      'arc',
      'opera',
      'vivaldi',
      'chromium',
      'atlas',
      'safari',
      'firefox',
    ];

    browsers.forEach((browser) => {
      it(`POSTs multipart to /api/integrations/cookies/upload for ${browser}`, async () => {
        install('/api/integrations/cookies/upload');
        const { window } = makeWindow();

        const result = await Uploader.uploadData(
          browser,
          [{ name: 'sid', value: 'abc' }],
          ACCESS_TOKEN,
          window
        );

        expect(result).toEqual({ success: true });
        expect(fetchCaptures).toHaveLength(1);
        const req = fetchCaptures[0];
        expect(req.url).toBe(`${BASE_URL}/api/integrations/cookies/upload`);
        expect(req.method).toBe('POST');
        expect(req.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
        expect(req.headers['content-type']).toMatch(/^multipart\/form-data/);
        expect(req.body).toContain('name="browser"');
        expect(req.body).toContain(browser);
        expect(req.body).toContain('name="data"');
        expect(req.body).toContain('name="iv"');
        expect(req.body).toContain('name="key"');
        // Raw cookie payload must NOT appear in plaintext on the wire.
        expect(req.body ?? '').not.toContain('"value":"abc"');
      });
    });
  });

  describe('chrome_local_storage integration', () => {
    it('POSTs multipart to /api/integrations/localStorage/upload with encrypted payload', async () => {
      install('/api/integrations/localStorage/upload');
      const { window } = makeWindow();

      const result = await Uploader.uploadData(
        'chrome_local_storage',
        { origin: 'https://example.com', items: { foo: 'bar' } },
        ACCESS_TOKEN,
        window
      );

      expect(result).toEqual({ success: true });
      expect(fetchCaptures).toHaveLength(1);
      const req = fetchCaptures[0];
      expect(req.url).toBe(`${BASE_URL}/api/integrations/localStorage/upload`);
      expect(req.method).toBe('POST');
      expect(req.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(req.headers['content-type']).toMatch(/^multipart\/form-data/);
      expect(req.body).toContain('name="data"');
      expect(req.body).toContain('name="iv"');
      expect(req.body).toContain('name="key"');
      // Plaintext value must not leak.
      expect(req.body ?? '').not.toContain('"foo":"bar"');
      // This endpoint does NOT carry an integrationType field.
      expect(req.body ?? '').not.toContain('name="integrationType"');
    });
  });

  describe('browser_fingerprint integration', () => {
    it('POSTs multipart to /api/integrations/fingerprint/upload with encrypted payload', async () => {
      install('/api/integrations/fingerprint/upload');
      const { window } = makeWindow();

      await Uploader.uploadData(
        'browser_fingerprint',
        { userAgent: 'test-ua' },
        ACCESS_TOKEN,
        window
      );

      expect(fetchCaptures).toHaveLength(1);
      const req = fetchCaptures[0];
      expect(req.url).toBe(`${BASE_URL}/api/integrations/fingerprint/upload`);
      expect(req.method).toBe('POST');
      expect(req.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(req.headers['content-type']).toMatch(/^multipart\/form-data/);
      expect(req.body).toContain('name="data"');
      expect(req.body).toContain('name="iv"');
      expect(req.body).toContain('name="key"');
      expect(req.body ?? '').not.toContain('test-ua');
    });
  });

  describe('generic integration fallback', () => {
    it('POSTs multipart to /api/integrations/upload with integrationType field for unknown types', async () => {
      install('/api/integrations/upload');
      const { window } = makeWindow();

      await Uploader.uploadData(
        'some_unknown_type',
        { field: 'secret-data' },
        ACCESS_TOKEN,
        window
      );

      expect(fetchCaptures).toHaveLength(1);
      const req = fetchCaptures[0];
      expect(req.url).toBe(`${BASE_URL}/api/integrations/upload`);
      expect(req.method).toBe('POST');
      expect(req.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(req.headers['content-type']).toMatch(/^multipart\/form-data/);
      expect(req.body).toContain('name="integrationType"');
      expect(req.body).toContain('some_unknown_type');
      expect(req.body).toContain('name="data"');
      expect(req.body).toContain('name="iv"');
      expect(req.body).toContain('name="key"');
      expect(req.body ?? '').not.toContain('secret-data');
    });

    it('emits upload:progress events tagged with the integration type', async () => {
      install('/api/integrations/upload');
      const { window, sendSpy } = makeWindow();

      await Uploader.uploadData('some_unknown_type', { a: 1 }, ACCESS_TOKEN, window);

      const progressCalls = sendSpy.mock.calls.filter(([channel]) => channel === 'upload:progress');
      expect(progressCalls).toHaveLength(2);
      expect(progressCalls[0][1]).toEqual({ type: 'some_unknown_type', percent: 50 });
      expect(progressCalls[1][1]).toEqual({ type: 'some_unknown_type', percent: 100 });
    });
  });

  describe('auth boundary', () => {
    it('forwards the provided access token verbatim as a Bearer credential', async () => {
      install('/api/integrations/imessage/upload');
      const { window } = makeWindow();
      const token = 'different-token-456';

      await Uploader.uploadData('imessage', [makeIMessage()], token, window);

      expect(fetchCaptures).toHaveLength(1);
      expect(fetchCaptures[0].headers['authorization']).toBe(`Bearer ${token}`);
    });

    it('still sends the Authorization header on multipart paths', async () => {
      install('/api/integrations/cookies/upload');
      const { window } = makeWindow();

      await Uploader.uploadData('chrome', [{ name: 'x' }], 'abc', window);

      expect(fetchCaptures).toHaveLength(1);
      expect(fetchCaptures[0].headers['authorization']).toBe('Bearer abc');
    });
  });

  describe('error state', () => {
    it('returns { success: false, message } when the server responds non-OK', async () => {
      install(
        '/api/integrations/imessage/upload',
        () =>
          new Response(JSON.stringify({ error: 'boom' }), {
            status: 500,
            statusText: 'Internal Server Error',
          })
      );
      const { window } = makeWindow();

      const result = await Uploader.uploadData('imessage', [makeIMessage()], ACCESS_TOKEN, window);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Upload failed/);
      expect(result.message).toMatch(/Internal Server Error/);
      expect(fetchCaptures).toHaveLength(1);
      expect(fetchCaptures[0].responseStatus).toBe(500);
    });

    it('returns { success: false, message } when fetch itself throws', async () => {
      const prev = globalThis.fetch;
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error('network unreachable')) as unknown as typeof globalThis.fetch;
      try {
        const { window } = makeWindow();
        const result = await Uploader.uploadData(
          'imessage',
          [makeIMessage()],
          ACCESS_TOKEN,
          window
        );
        expect(result).toEqual({ success: false, message: 'network unreachable' });
      } finally {
        globalThis.fetch = prev;
      }
    });
  });

  describe('window optional', () => {
    it('succeeds with a null window (no progress events emitted)', async () => {
      install('/api/integrations/imessage/upload');

      const result = await Uploader.uploadData('imessage', [makeIMessage()], ACCESS_TOKEN, null);

      expect(result).toEqual({ success: true });
      expect(fetchCaptures).toHaveLength(1);
    });
  });

  describe('fetch-capture boundary assertions', () => {
    it('each upload produces exactly one outbound fetch call', async () => {
      install('/api/integrations/imessage/upload');
      const { window } = makeWindow();

      await Uploader.uploadData('imessage', [makeIMessage()], ACCESS_TOKEN, window);

      expect(fetchCaptures).toHaveLength(1);
    });

    it('routes each integration type to its dedicated endpoint', async () => {
      const cases: Array<{
        type: string;
        data: unknown;
        path: string;
      }> = [
        { type: 'imessage', data: [makeIMessage()], path: '/api/integrations/imessage/upload' },
        {
          type: 'whatsapp',
          data: [{ contact_id: 'w', messages: [] }],
          path: '/api/integrations/whatsapp/upload',
        },
        {
          type: 'telegram',
          data: [{ contact_id: 't', messages: [] }],
          path: '/api/integrations/telegram/upload',
        },
        { type: 'chrome', data: [{ name: 'c' }], path: '/api/integrations/cookies/upload' },
        { type: 'firefox', data: [{ name: 'f' }], path: '/api/integrations/cookies/upload' },
        {
          type: 'chrome_local_storage',
          data: { items: {} },
          path: '/api/integrations/localStorage/upload',
        },
        {
          type: 'browser_fingerprint',
          data: { ua: 'x' },
          path: '/api/integrations/fingerprint/upload',
        },
        { type: 'unknown_type', data: { a: 1 }, path: '/api/integrations/upload' },
      ];

      for (const c of cases) {
        clearFetchCaptures();
        restoreFetch?.();
        restoreFetch = installFetchCapture({ [c.path]: okResponder });
        const { window } = makeWindow();

        const result = await Uploader.uploadData(c.type, c.data, ACCESS_TOKEN, window);

        expect(result, `type=${c.type}`).toEqual({ success: true });
        expect(fetchCaptures, `type=${c.type}`).toHaveLength(1);
        expect(fetchCaptures[0].url, `type=${c.type}`).toBe(`${BASE_URL}${c.path}`);
        expect(fetchCaptures[0].method, `type=${c.type}`).toBe('POST');
      }
    });
  });
});
