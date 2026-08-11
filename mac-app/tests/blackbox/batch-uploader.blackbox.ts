/**
 * Blackbox tests for the batch-uploader domain.
 *
 * Surface under test (from `npx tsx scripts/map-domains.ts batch-uploader`):
 *   - main/services/batchUploader.ts   (BatchUploader: wraps Uploader with logging + item-count)
 *   - main/services/uploader.ts        (Uploader: the sole fetch boundary for every integration type)
 *   - main/base/config.ts              (apiUrl + encryptionKey — mocked)
 *   - main/base/crypto.ts              (AES-256-CBC encrypt — used live for cookie/localStorage/fingerprint/generic)
 *   - shared/types/ipc.ts              (IMessageData, UploadResult, etc. — types only)
 *
 * The domain is a "main-service": no IPC handlers, no UI. Its observable contract is:
 *   1. What outbound HTTP request is sent for each integrationType (URL, method, headers, body)
 *   2. What UploadResult is returned (success/failure + message)
 *   3. What progress events are pushed to the BrowserWindow's webContents
 *
 * We keep Uploader + Crypto REAL so the encrypted payload path is exercised end-to-end,
 * and capture the outbound fetch via installFetchCapture.
 *
 * Scope deferrals (per batch prompt):
 *   - flake×5 reruns, concurrent invocations, negative-control checks, broader-suite verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import type { BrowserWindow } from 'electron';
import { stubAllElectron } from './electron-stubs';
import { fetchCaptures, clearFetchCaptures, installFetchCapture } from './fetch-capture';
import type { IMessageData, IMessageUploadContact, UploadResult } from '../../shared/types/ipc';

stubAllElectron();

// Config must be mocked before the domain imports below because Uploader's
// module init reaches `config.apiUrl`. Uploader uses raw console for logging,
// so no logger stub is needed.
vi.mock('../../main/base/config', () => ({
  config: {
    apiUrl: 'https://backend.test',
    supabase: { url: 'https://supabase.test', anonKey: 'anon-test' },
    encryptionKey: 'encryption-key-test',
    isDev: true,
  },
}));

// ---------------------------------------------------------------------------
// Imports — after mocks. We import Uploader + BatchUploader directly so the
// real encrypt → fetch path runs.
// ---------------------------------------------------------------------------

import { BatchUploader } from '../../main/services/batchUploader';
import { Uploader } from '../../main/services/uploader';
import { Crypto as UploadCrypto } from '../../main/base/crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * Fake BrowserWindow-like shape used to assert upload:progress events. Only
 * the fields Uploader touches are required.
 */
function makeFakeWindow(): { sendSpy: ReturnType<typeof vi.fn>; window: BrowserWindow } {
  const sendSpy = vi.fn();
  const window = {
    webContents: { send: sendSpy },
  } as unknown as BrowserWindow;
  return { sendSpy, window };
}

/**
 * Decrypt a payload produced by the real Crypto.encrypt helper. Used to prove
 * the encrypted body we captured actually matches the input data.
 */
function decryptPayload(encrypted: string, iv: string, key: string): string {
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    Buffer.from(key, 'hex'),
    Buffer.from(iv, 'hex')
  );
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'hex')), decipher.final()]).toString(
    'utf8'
  );
}

/**
 * Parse a multipart/form-data request body into a string-keyed map. Uploader
 * only appends string values to FormData, so stringifying each entry is safe.
 */
async function parseFormData(
  rawBody: string,
  contentType: string | undefined
): Promise<Record<string, string>> {
  const response = new Response(rawBody, {
    headers: contentType ? { 'content-type': contentType } : {},
  });
  const form = await response.formData();
  return Object.fromEntries(Array.from(form.entries()).map(([k, v]) => [k, String(v)]));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('batch-uploader blackbox', () => {
  let restoreFetch: () => void = () => {};

  beforeEach(() => {
    clearFetchCaptures();
  });

  afterEach(() => {
    restoreFetch();
    restoreFetch = () => {};
  });

  // -------------------------------------------------------------------------
  // Auth boundary: Authorization: Bearer <accessToken> is the single auth
  // token the whole domain forwards. Every integration type must include it.
  // -------------------------------------------------------------------------

  describe('auth boundary', () => {
    it('forwards Bearer access token on JSON integration (imessage)', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/imessage/upload': () => jsonResponse({ ok: true }),
      });

      const result = await BatchUploader.uploadInBatches('imessage', [], 'tok-auth-test', null);

      expect(result.success).toBe(true);
      expect(fetchCaptures).toHaveLength(1);
      expect(fetchCaptures[0].headers['authorization']).toBe('Bearer tok-auth-test');
    });

    it('forwards Bearer access token on encrypted integration (chrome cookies)', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/cookies/upload': () => jsonResponse({ ok: true }),
      });

      const result = await BatchUploader.uploadInBatches(
        'chrome',
        [{ host_key: '.x', name: 'a', value: 'b' }],
        'tok-cookie-auth',
        null
      );

      expect(result.success).toBe(true);
      expect(fetchCaptures[0].headers['authorization']).toBe('Bearer tok-cookie-auth');
    });
  });

  describe('transient transport recovery', () => {
    it('retries an idempotent browser-cookie snapshot after a transient fetch failure', async () => {
      const originalFetch = globalThis.fetch;
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
      vi.useFakeTimers();

      try {
        const upload = BatchUploader.uploadInBatches(
          'chrome',
          [{ host_key: '.x', name: 'session', value: 'fresh' }],
          'tok-cookie-retry',
          null
        );
        await vi.advanceTimersByTimeAsync(1_000);

        await expect(upload).resolves.toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
        globalThis.fetch = originalFetch;
      }
    });

    it('stops browser-cookie transport recovery after exactly three failed attempts', async () => {
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn().mockRejectedValue(new Error('persistent fetch failure'));
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
      vi.useFakeTimers();

      try {
        const upload = BatchUploader.uploadInBatches(
          'chrome',
          [{ host_key: '.x', name: 'session', value: 'fresh' }],
          'tok-cookie-exhaustion',
          null
        );
        await vi.advanceTimersByTimeAsync(3_000);

        await expect(upload).resolves.toEqual({
          success: false,
          message: 'persistent fetch failure',
        });
        expect(fetchMock).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
        globalThis.fetch = originalFetch;
      }
    });

    it('does not retry a browser-cookie HTTP rejection', async () => {
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'rejected' }), {
          status: 503,
          statusText: 'Service Unavailable',
        })
      );
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      try {
        const result = await BatchUploader.uploadInBatches(
          'chrome',
          [{ host_key: '.x', name: 'session', value: 'fresh' }],
          'tok-cookie-http-rejection',
          null
        );

        expect(result).toEqual({
          success: false,
          message: 'Upload failed: Service Unavailable',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('does not retry a non-cookie transport failure', async () => {
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn().mockRejectedValue(new Error('message transport failed'));
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      try {
        const result = await BatchUploader.uploadInBatches('imessage', [], 'tok-message', null);

        expect(result).toEqual({ success: false, message: 'message transport failed' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('does not retry a browser-cookie failure before the transport boundary', async () => {
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn();
      const encryptSpy = vi.spyOn(UploadCrypto, 'encrypt').mockImplementation(() => {
        throw new Error('cookie encryption failed');
      });
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
      vi.useFakeTimers();

      try {
        const upload = BatchUploader.uploadInBatches(
          'chrome',
          [{ host_key: '.x', name: 'session', value: 'fresh' }],
          'tok-cookie-encryption',
          null
        );
        await vi.advanceTimersByTimeAsync(3_000);

        await expect(upload).resolves.toEqual({
          success: false,
          message: 'cookie encryption failed',
        });
        expect(encryptSpy).toHaveBeenCalledTimes(1);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
        encryptSpy.mockRestore();
        globalThis.fetch = originalFetch;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Happy path routing: each integrationType hits a specific URL with the
  // correct content-type and body shape. This is the contract between the
  // mac app and the backend's /api/integrations/* endpoints.
  // -------------------------------------------------------------------------

  describe('happy path routing per integrationType', () => {
    it('imessage: POSTs JSON to /api/integrations/imessage/upload with {contacts, accessedAt}', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/imessage/upload': () => jsonResponse({ ok: true }),
      });

      const data: IMessageData[] = [
        {
          id: 1,
          text: 'hello',
          date: 123,
          is_from_me: false,
          contact_id: '+15551234567',
          contact_name: 'Alice',
        },
      ];

      const result = await BatchUploader.uploadInBatches('imessage', data, 'tok', null);

      expect(result.success).toBe(true);
      expect(fetchCaptures).toHaveLength(1);
      const call = fetchCaptures[0];
      expect(call.url).toBe('https://backend.test/api/integrations/imessage/upload');
      expect(call.method).toBe('POST');
      expect(call.headers['content-type']).toBe('application/json');
      const body = JSON.parse(call.body ?? '{}');
      expect(Array.isArray(body.contacts)).toBe(true);
      expect(body.contacts[0].contact_id).toBe('+15551234567');
      expect(body.contacts[0].phoneNumber).toBe('+15551234567');
      expect(body.contacts[0].messages[0].text).toBe('hello');
      expect(typeof body.accessedAt).toBe('string');
    });

    it('whatsapp: POSTs JSON to /api/integrations/whatsapp/upload', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/whatsapp/upload': () => jsonResponse({ ok: true }),
      });

      const contacts = [{ contact_id: 'wa-1', messages: [{ id: '1', text: 'hi' }] }];
      const result = await BatchUploader.uploadInBatches('whatsapp', contacts, 'tok', null);

      expect(result.success).toBe(true);
      const call = fetchCaptures[0];
      expect(call.url).toBe('https://backend.test/api/integrations/whatsapp/upload');
      expect(call.method).toBe('POST');
      expect(call.headers['content-type']).toBe('application/json');
      const body = JSON.parse(call.body ?? '{}');
      expect(body.contacts).toEqual(contacts);
      expect(typeof body.accessedAt).toBe('string');
    });

    it('telegram: POSTs JSON to /api/integrations/telegram/upload', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/telegram/upload': () => jsonResponse({ ok: true }),
      });

      const contacts = [{ contact_id: 'tg-1', messages: [] }];
      const result = await BatchUploader.uploadInBatches('telegram', contacts, 'tok', null);

      expect(result.success).toBe(true);
      const call = fetchCaptures[0];
      expect(call.url).toBe('https://backend.test/api/integrations/telegram/upload');
      expect(call.method).toBe('POST');
      expect(call.headers['content-type']).toBe('application/json');
      const body = JSON.parse(call.body ?? '{}');
      expect(body.contacts).toEqual(contacts);
      expect(typeof body.accessedAt).toBe('string');
    });

    it.each([
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
    ])(
      '%s cookies: POSTs multipart to /api/integrations/cookies/upload with encrypted+iv+key+browser',
      async (browser) => {
        restoreFetch = installFetchCapture({
          '/api/integrations/cookies/upload': () => jsonResponse({ ok: true }),
        });

        const cookies = [{ host_key: `.${browser}.test`, name: 's', value: 'v' }];
        const result = await BatchUploader.uploadInBatches(browser, cookies, 'tok', null);

        expect(result.success).toBe(true);
        const call = fetchCaptures[0];
        expect(call.url).toBe('https://backend.test/api/integrations/cookies/upload');
        expect(call.method).toBe('POST');
        expect(call.headers['content-type']).toMatch(/^multipart\/form-data/);

        const form = await parseFormData(call.body ?? '', call.headers['content-type']);
        expect(form.browser).toBe(browser);
        expect(form.data).toMatch(/^[0-9a-f]+$/);
        expect(form.iv).toMatch(/^[0-9a-f]{32}$/);
        expect(form.key).toMatch(/^[0-9a-f]{64}$/);
        // Decrypted payload matches the original JSON.
        expect(decryptPayload(form.data, form.iv, form.key)).toBe(JSON.stringify(cookies));
      }
    );

    it('chrome_local_storage: POSTs multipart to /api/integrations/localStorage/upload (no browser field)', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/localStorage/upload': () => jsonResponse({ ok: true }),
      });

      const payload = { 'site.test': { key: 'value' } };
      const result = await BatchUploader.uploadInBatches(
        'chrome_local_storage',
        payload,
        'tok',
        null
      );

      expect(result.success).toBe(true);
      const call = fetchCaptures[0];
      expect(call.url).toBe('https://backend.test/api/integrations/localStorage/upload');
      expect(call.method).toBe('POST');
      expect(call.headers['content-type']).toMatch(/^multipart\/form-data/);

      const form = await parseFormData(call.body ?? '', call.headers['content-type']);
      expect(form.data).toMatch(/^[0-9a-f]+$/);
      expect(form.iv).toMatch(/^[0-9a-f]{32}$/);
      expect(form.key).toMatch(/^[0-9a-f]{64}$/);
      expect(form.browser).toBeUndefined();
      expect(form.integrationType).toBeUndefined();
      expect(decryptPayload(form.data, form.iv, form.key)).toBe(JSON.stringify(payload));
    });

    it('browser_fingerprint: POSTs multipart to /api/integrations/fingerprint/upload', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/fingerprint/upload': () => jsonResponse({ ok: true }),
      });

      const payload = { navigator: { userAgent: 'ua' } };
      const result = await BatchUploader.uploadInBatches(
        'browser_fingerprint',
        payload,
        'tok',
        null
      );

      expect(result.success).toBe(true);
      const call = fetchCaptures[0];
      expect(call.url).toBe('https://backend.test/api/integrations/fingerprint/upload');
      expect(call.method).toBe('POST');
      expect(call.headers['content-type']).toMatch(/^multipart\/form-data/);

      const form = await parseFormData(call.body ?? '', call.headers['content-type']);
      expect(form.data).toMatch(/^[0-9a-f]+$/);
      expect(form.iv).toMatch(/^[0-9a-f]{32}$/);
      expect(form.key).toMatch(/^[0-9a-f]{64}$/);
      expect(form.browser).toBeUndefined();
      expect(form.integrationType).toBeUndefined();
      expect(decryptPayload(form.data, form.iv, form.key)).toBe(JSON.stringify(payload));
    });

    it('generic fallback: unknown integrationType → /api/integrations/upload with integrationType field', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/upload': () => jsonResponse({ ok: true }),
      });

      const payload = { foo: 'bar' };
      const result = await BatchUploader.uploadInBatches('gmail', payload, 'tok', null);

      expect(result.success).toBe(true);
      const call = fetchCaptures[0];
      expect(call.url).toBe('https://backend.test/api/integrations/upload');
      expect(call.method).toBe('POST');
      expect(call.headers['content-type']).toMatch(/^multipart\/form-data/);

      const form = await parseFormData(call.body ?? '', call.headers['content-type']);
      expect(form.integrationType).toBe('gmail');
      expect(form.data).toMatch(/^[0-9a-f]+$/);
      expect(form.iv).toMatch(/^[0-9a-f]{32}$/);
      expect(form.key).toMatch(/^[0-9a-f]{64}$/);
      expect(form.browser).toBeUndefined();
      expect(decryptPayload(form.data, form.iv, form.key)).toBe(JSON.stringify(payload));
    });
  });

  // -------------------------------------------------------------------------
  // iMessage payload building: the Uploader internally normalizes IMessageData[]
  // into a grouped { contacts } payload. Assert the observable output.
  // -------------------------------------------------------------------------

  describe('imessage payload normalization', () => {
    it('groups flat IMessageData[] by contact_id (one contact → multiple messages)', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/imessage/upload': () => jsonResponse({ ok: true }),
      });

      const data: IMessageData[] = [
        {
          id: 1,
          text: 'm1',
          date: 100,
          is_from_me: false,
          contact_id: '+111',
          contact_name: 'Alice',
        },
        {
          id: 2,
          text: 'm2',
          date: 200,
          is_from_me: true,
          contact_id: '+111',
          contact_name: 'Alice',
        },
        {
          id: 3,
          text: 'm3',
          date: 300,
          is_from_me: false,
          contact_id: '+222',
          contact_name: 'Bob',
        },
      ];

      await BatchUploader.uploadInBatches('imessage', data, 'tok', null);

      const body = JSON.parse(fetchCaptures[0].body ?? '{}');
      expect(body.contacts).toHaveLength(2);
      const byId = Object.fromEntries(
        body.contacts.map((c: IMessageUploadContact) => [c.contact_id, c])
      );
      expect(byId['+111'].messages.map((m: { id: number }) => m.id)).toEqual([1, 2]);
      expect(byId['+222'].messages.map((m: { id: number }) => m.id)).toEqual([3]);
      expect(byId['+111'].phoneNumber).toBe('+111');
      expect(byId['+111'].email).toBeNull();
    });

    it('detects email contact_id (handle contains @) and routes to email field, not phoneNumber', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/imessage/upload': () => jsonResponse({ ok: true }),
      });

      const data: IMessageData[] = [
        {
          id: 1,
          text: 'm1',
          date: 100,
          is_from_me: false,
          contact_id: 'bob@example.com',
          contact_name: 'Bob',
        },
      ];

      await BatchUploader.uploadInBatches('imessage', data, 'tok', null);

      const body = JSON.parse(fetchCaptures[0].body ?? '{}');
      expect(body.contacts).toHaveLength(1);
      expect(body.contacts[0].email).toBe('bob@example.com');
      expect(body.contacts[0].phoneNumber).toBeNull();
    });

    it('pre-structured IMessageUploadContact[] passes through without regrouping', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/imessage/upload': () => jsonResponse({ ok: true }),
      });

      const structured: IMessageUploadContact[] = [
        {
          contact_id: 'pre-1',
          contact_name: 'Preset',
          phoneNumber: '+999',
          email: null,
          firstName: 'Pre',
          lastName: 'Set',
          company: null,
          title: null,
          emailAddresses: [],
          messages: [{ id: 10, text: 'pre-m', date: 1, is_from_me: false, contactHandle: 'pre-1' }],
        },
      ];

      await BatchUploader.uploadInBatches('imessage', structured, 'tok', null);

      const body = JSON.parse(fetchCaptures[0].body ?? '{}');
      expect(body.contacts).toHaveLength(1);
      expect(body.contacts[0]).toMatchObject({
        contact_id: 'pre-1',
        phoneNumber: '+999',
        firstName: 'Pre',
        lastName: 'Set',
      });
      expect(body.contacts[0].messages).toHaveLength(1);
      expect(body.contacts[0].messages[0].id).toBe(10);
    });

    it('skips messages with empty contact_id instead of creating a null-handle contact', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/imessage/upload': () => jsonResponse({ ok: true }),
      });

      const data: IMessageData[] = [
        {
          id: 1,
          text: 'orphan',
          date: 1,
          is_from_me: false,
          contact_id: '',
          contact_name: null,
        },
        {
          id: 2,
          text: 'kept',
          date: 2,
          is_from_me: false,
          contact_id: '+333',
          contact_name: 'Carol',
        },
      ];

      await BatchUploader.uploadInBatches('imessage', data, 'tok', null);

      const body = JSON.parse(fetchCaptures[0].body ?? '{}');
      expect(body.contacts).toHaveLength(1);
      expect(body.contacts[0].contact_id).toBe('+333');
    });
  });

  // -------------------------------------------------------------------------
  // Empty state: empty array input still produces a well-formed request. The
  // backend must always receive a valid `{contacts: [], accessedAt}` envelope
  // rather than a malformed body.
  // -------------------------------------------------------------------------

  describe('empty state', () => {
    it('imessage with empty array posts {contacts:[], accessedAt}', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/imessage/upload': () => jsonResponse({ ok: true }),
      });

      const result = await BatchUploader.uploadInBatches('imessage', [], 'tok', null);

      expect(result.success).toBe(true);
      expect(fetchCaptures).toHaveLength(1);
      const body = JSON.parse(fetchCaptures[0].body ?? '{}');
      expect(body.contacts).toEqual([]);
      expect(typeof body.accessedAt).toBe('string');
    });

    it('imessage with non-array data degrades to {contacts:[]}', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/imessage/upload': () => jsonResponse({ ok: true }),
      });

      const result = await BatchUploader.uploadInBatches(
        'imessage',
        { not: 'an array' },
        'tok',
        null
      );

      expect(result.success).toBe(true);
      const body = JSON.parse(fetchCaptures[0].body ?? '{}');
      expect(body.contacts).toEqual([]);
    });

    it('cookie upload with empty list still produces valid encrypted multipart payload', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/cookies/upload': () => jsonResponse({ ok: true }),
      });

      const result = await BatchUploader.uploadInBatches('chrome', [], 'tok', null);

      expect(result.success).toBe(true);
      const form = await parseFormData(
        fetchCaptures[0].body ?? '',
        fetchCaptures[0].headers['content-type']
      );
      expect(form.browser).toBe('chrome');
      expect(decryptPayload(form.data, form.iv, form.key)).toBe('[]');
    });
  });

  // -------------------------------------------------------------------------
  // Error state: non-2xx and thrown-fetch cases must return a structured
  // UploadResult {success:false, message} — never throw to the caller.
  // -------------------------------------------------------------------------

  describe('error state', () => {
    it('non-2xx response → UploadResult{success:false, message} without throwing', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/imessage/upload': () =>
          new Response(JSON.stringify({ error: 'boom' }), {
            status: 500,
            statusText: 'Internal Server Error',
            headers: { 'content-type': 'application/json' },
          }),
      });

      const result: UploadResult = await BatchUploader.uploadInBatches('imessage', [], 'tok', null);

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Upload failed/);
      // Boundary still captured so the contract is visible even on failure.
      expect(fetchCaptures).toHaveLength(1);
    });

    it('fetch throws → UploadResult{success:false, message} carries the error', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(() =>
        Promise.reject(new Error('network down'))
      ) as unknown as typeof fetch;
      restoreFetch = () => {
        globalThis.fetch = originalFetch;
      };

      const result = await BatchUploader.uploadInBatches('imessage', [], 'tok', null);

      expect(result.success).toBe(false);
      expect(result.message).toBe('network down');
    });

    it('non-Error thrown → UploadResult message is "Unknown error"', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(() => Promise.reject('string failure')) as unknown as typeof fetch;
      restoreFetch = () => {
        globalThis.fetch = originalFetch;
      };

      const result = await BatchUploader.uploadInBatches('imessage', [], 'tok', null);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Unknown error');
    });
  });

  // -------------------------------------------------------------------------
  // Progress events: Uploader pushes upload:progress at 50% (before network)
  // and 100% (after network succeeds). On failure, the 100% event does NOT
  // fire (error surfaces before the post-fetch send call).
  // -------------------------------------------------------------------------

  describe('progress events', () => {
    it('happy path: emits upload:progress 50 then 100 with integrationType', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/imessage/upload': () => jsonResponse({ ok: true }),
      });
      const { sendSpy, window } = makeFakeWindow();

      await BatchUploader.uploadInBatches('imessage', [], 'tok', window);

      const progressEvents = sendSpy.mock.calls
        .filter(([channel]) => channel === 'upload:progress')
        .map(([, payload]) => payload);
      expect(progressEvents).toEqual([
        { type: 'imessage', percent: 50 },
        { type: 'imessage', percent: 100 },
      ]);
    });

    it('window=null: does not throw when no window is attached', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/imessage/upload': () => jsonResponse({ ok: true }),
      });

      const result = await BatchUploader.uploadInBatches('imessage', [], 'tok', null);

      expect(result.success).toBe(true);
    });

    it('error path: 50% and 100% still emit even when response is non-2xx (progress is reception-based, not success-based)', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/imessage/upload': () =>
          new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
      });
      const { sendSpy, window } = makeFakeWindow();

      const result = await BatchUploader.uploadInBatches('imessage', [], 'tok', window);

      expect(result.success).toBe(false);
      const progressEvents = sendSpy.mock.calls
        .filter(([channel]) => channel === 'upload:progress')
        .map(([, payload]) => payload);
      // Both progress events fire: 50% pre-fetch, 100% after the fetch returns.
      // The non-2xx failure is detected AFTER the 100% event is emitted, so
      // callers can't use 100% as a success signal — they must read UploadResult.
      expect(progressEvents).toContainEqual({ type: 'imessage', percent: 50 });
      expect(progressEvents).toContainEqual({ type: 'imessage', percent: 100 });
    });

    it('fetch-throws path: 50% fires but 100% does NOT (error short-circuits before the post-fetch send)', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(() =>
        Promise.reject(new Error('network down'))
      ) as unknown as typeof fetch;
      restoreFetch = () => {
        globalThis.fetch = originalFetch;
      };

      const { sendSpy, window } = makeFakeWindow();
      const result = await BatchUploader.uploadInBatches('imessage', [], 'tok', window);

      expect(result.success).toBe(false);
      const progressEvents = sendSpy.mock.calls
        .filter(([channel]) => channel === 'upload:progress')
        .map(([, payload]) => payload);
      expect(progressEvents).toContainEqual({ type: 'imessage', percent: 50 });
      expect(progressEvents).not.toContainEqual({ type: 'imessage', percent: 100 });
    });
  });

  // -------------------------------------------------------------------------
  // Boundary capture assertions (fetch-capture): lock down the exact URL +
  // method + header + body-shape contract for each integration family. Each
  // `it` records the captured call and asserts on its full shape.
  // -------------------------------------------------------------------------

  describe('fetch-capture boundary contract', () => {
    it('records exactly one outbound call per uploadInBatches invocation', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/imessage/upload': () => jsonResponse({ ok: true }),
      });

      await BatchUploader.uploadInBatches('imessage', [], 'tok', null);
      expect(fetchCaptures).toHaveLength(1);

      await BatchUploader.uploadInBatches('imessage', [], 'tok', null);
      expect(fetchCaptures).toHaveLength(2);
    });

    it('captures bearer header + url + method for every integration family in one flow', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/imessage/upload': () => jsonResponse({ ok: true }),
        '/api/integrations/whatsapp/upload': () => jsonResponse({ ok: true }),
        '/api/integrations/telegram/upload': () => jsonResponse({ ok: true }),
        '/api/integrations/cookies/upload': () => jsonResponse({ ok: true }),
        '/api/integrations/localStorage/upload': () => jsonResponse({ ok: true }),
        '/api/integrations/fingerprint/upload': () => jsonResponse({ ok: true }),
        '/api/integrations/upload': () => jsonResponse({ ok: true }),
      });

      await Uploader.uploadData('imessage', [], 'tok', null);
      await Uploader.uploadData('whatsapp', [], 'tok', null);
      await Uploader.uploadData('telegram', [], 'tok', null);
      await Uploader.uploadData('chrome', [], 'tok', null);
      await Uploader.uploadData('chrome_local_storage', {}, 'tok', null);
      await Uploader.uploadData('browser_fingerprint', {}, 'tok', null);
      await Uploader.uploadData('gmail', {}, 'tok', null);

      expect(fetchCaptures).toHaveLength(7);
      const urls = fetchCaptures.map((c) => c.url);
      expect(urls).toEqual([
        'https://backend.test/api/integrations/imessage/upload',
        'https://backend.test/api/integrations/whatsapp/upload',
        'https://backend.test/api/integrations/telegram/upload',
        'https://backend.test/api/integrations/cookies/upload',
        'https://backend.test/api/integrations/localStorage/upload',
        'https://backend.test/api/integrations/fingerprint/upload',
        'https://backend.test/api/integrations/upload',
      ]);
      for (const c of fetchCaptures) {
        expect(c.method).toBe('POST');
        expect(c.headers['authorization']).toBe('Bearer tok');
      }
    });

    it('encrypted integrations produce fresh IV + key per upload (never reused)', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/cookies/upload': () => jsonResponse({ ok: true }),
      });

      await BatchUploader.uploadInBatches('chrome', [{ a: 1 }], 'tok', null);
      await BatchUploader.uploadInBatches('chrome', [{ a: 1 }], 'tok', null);

      const form1 = await parseFormData(
        fetchCaptures[0].body ?? '',
        fetchCaptures[0].headers['content-type']
      );
      const form2 = await parseFormData(
        fetchCaptures[1].body ?? '',
        fetchCaptures[1].headers['content-type']
      );

      expect(form1.iv).not.toBe(form2.iv);
      expect(form1.key).not.toBe(form2.key);
      expect(form1.data).not.toBe(form2.data);
    });
  });

  // -------------------------------------------------------------------------
  // BatchUploader identity: it currently delegates 1:1 to Uploader. Lock that
  // contract so a future regression (e.g. wrong integrationType forwarded)
  // is caught immediately.
  // -------------------------------------------------------------------------

  describe('BatchUploader identity', () => {
    it('uploadInBatches result is byte-identical to Uploader.uploadData result (success)', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/imessage/upload': () => jsonResponse({ ok: true }),
      });
      const direct = await Uploader.uploadData('imessage', [], 'tok', null);

      restoreFetch();
      clearFetchCaptures();
      restoreFetch = installFetchCapture({
        '/api/integrations/imessage/upload': () => jsonResponse({ ok: true }),
      });
      const viaBatch = await BatchUploader.uploadInBatches('imessage', [], 'tok', null);

      expect(viaBatch).toEqual(direct);
    });

    it('uploadInBatches result is byte-identical to Uploader.uploadData result (failure)', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/imessage/upload': () =>
          new Response('nope', { status: 500, statusText: 'Internal Server Error' }),
      });
      const direct = await Uploader.uploadData('imessage', [], 'tok', null);

      restoreFetch();
      clearFetchCaptures();
      restoreFetch = installFetchCapture({
        '/api/integrations/imessage/upload': () =>
          new Response('nope', { status: 500, statusText: 'Internal Server Error' }),
      });
      const viaBatch = await BatchUploader.uploadInBatches('imessage', [], 'tok', null);

      expect(viaBatch).toEqual(direct);
      expect(viaBatch.success).toBe(false);
    });

    it('forwards integrationType verbatim (whatsapp → whatsapp URL, not imessage URL)', async () => {
      restoreFetch = installFetchCapture({
        '/api/integrations/whatsapp/upload': () => jsonResponse({ ok: true }),
      });

      await BatchUploader.uploadInBatches('whatsapp', [], 'tok', null);

      expect(fetchCaptures).toHaveLength(1);
      expect(fetchCaptures[0].url).toContain('/api/integrations/whatsapp/upload');
      expect(fetchCaptures[0].url).not.toContain('imessage');
    });
  });
});
