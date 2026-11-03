/**
 * Blackbox tests for src/features/integrations/api.ts.
 *
 * Exercises every exported API function on both the happy path and error path:
 *   - getAuthHeaders             — guard throws when no session
 *   - fetchIntegrationsApi       — maps 200 + empty arr on 4xx
 *   - uploadFileApi              — posts FormData for vcf + email-zip
 *   - startGmailOAuthApi         — returns { authUrl } or throws
 *   - sendPasswordRequestApi     — void on 200; throws on 500
 *   - uploadApplePasswordsApi    — posts CSV FormData; throws on error
 *   - createLinkedInSyncAgentApi — creates a normal agent, records it as the LinkedIn sync, throws on error
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from './msw/server';

import {
  getAuthHeaders,
  fetchIntegrationsApi,
  uploadFileApi,
  startGmailOAuthApi,
  sendPasswordRequestApi,
  uploadApplePasswordsApi,
  createLinkedInSyncAgentApi,
} from '@/features/integrations/api';

const API_BASE = 'http://localhost:3001/api';

function mockSession() {
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'test-user', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  localStorage.setItem('app-user', JSON.stringify({ id: 'test-user', is_anonymous: false }));
}

describe('integrations/api', () => {
  beforeEach(() => {
    mockSession();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('getAuthHeaders', () => {
    it('returns Bearer + JSON content type when authenticated', () => {
      const headers = getAuthHeaders();
      expect(headers.Authorization).toBe('Bearer test-token');
      expect(headers['Content-Type']).toBe('application/json');
    });
    it('throws when no session is present', () => {
      localStorage.clear();
      expect(() => getAuthHeaders()).toThrow('Not authenticated');
    });
  });

  describe('fetchIntegrationsApi', () => {
    it('returns the integrations array on 200', async () => {
      server.use(
        http.get(`${API_BASE}/integrations`, () =>
          HttpResponse.json({
            integrations: [{ id: 'gmail', name: 'Gmail', status: 'CONNECTED', isActive: true }],
          }),
        ),
      );
      const out = await fetchIntegrationsApi();
      expect(out).toEqual([{ id: 'gmail', name: 'Gmail', status: 'CONNECTED', isActive: true }]);
    });

    it('returns [] when integrations field is missing', async () => {
      server.use(http.get(`${API_BASE}/integrations`, () => HttpResponse.json({})));
      const out = await fetchIntegrationsApi();
      expect(out).toEqual([]);
    });

    it('returns [] when the API returns non-OK', async () => {
      server.use(
        http.get(`${API_BASE}/integrations`, () => new HttpResponse(null, { status: 500 })),
      );
      const out = await fetchIntegrationsApi();
      expect(out).toEqual([]);
    });

    it('throws "Not authenticated" when no session', async () => {
      localStorage.clear();
      await expect(fetchIntegrationsApi()).rejects.toThrow('Not authenticated');
    });
  });

  describe('uploadFileApi', () => {
    it('uploads a VCF file to the contacts endpoint', async () => {
      let capturedEndpoint = '';
      server.use(
        http.post(`${API_BASE}/integrations/contacts/upload`, ({ request }) => {
          capturedEndpoint = request.url;
          return HttpResponse.json({ created: 5, updated: 2, skipped: 0 });
        }),
      );
      const file = new File(['vcard'], 'c.vcf', { type: 'text/vcard' });
      const result = await uploadFileApi('vcf', file);
      expect(result).toEqual({ created: 5, updated: 2, skipped: 0 });
      expect(capturedEndpoint).toContain('/integrations/contacts/upload');
    });

    it('uploads an email ZIP file to the email endpoint', async () => {
      let capturedEndpoint = '';
      server.use(
        http.post(`${API_BASE}/integrations/email/upload`, ({ request }) => {
          capturedEndpoint = request.url;
          return HttpResponse.json({ message: 'ok' });
        }),
      );
      const file = new File([new Uint8Array([1, 2, 3])], 'email.zip');
      const result = await uploadFileApi('email-zip', file);
      expect(result).toEqual({ message: 'ok' });
      expect(capturedEndpoint).toContain('/integrations/email/upload');
    });

    it('throws error from the API payload on failure', async () => {
      server.use(
        http.post(`${API_BASE}/integrations/contacts/upload`, () =>
          HttpResponse.json({ error: 'bad format' }, { status: 400 }),
        ),
      );
      const file = new File(['x'], 'c.vcf');
      await expect(uploadFileApi('vcf', file)).rejects.toThrow('bad format');
    });

    it('falls back to a default message when payload has no error', async () => {
      server.use(
        http.post(
          `${API_BASE}/integrations/contacts/upload`,
          () => new HttpResponse('not-json', { status: 500 }),
        ),
      );
      const file = new File(['x'], 'c.vcf');
      await expect(uploadFileApi('vcf', file)).rejects.toThrow(/failed to upload file/i);
    });

    it('throws "Not authenticated" without a session', async () => {
      localStorage.clear();
      const file = new File(['x'], 'c.vcf');
      await expect(uploadFileApi('vcf', file)).rejects.toThrow('Not authenticated');
    });
  });

  describe('startGmailOAuthApi', () => {
    it('returns { authUrl } on success; sends returnUrl when provided', async () => {
      let body: Record<string, unknown> = null;
      server.use(
        http.post(`${API_BASE}/integrations/email/gmail/start`, async ({ request }) => {
          body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ authUrl: 'https://g.com/auth' });
        }),
      );
      const out = await startGmailOAuthApi('https://return.me');
      expect(out).toEqual({ authUrl: 'https://g.com/auth' });
      expect(body).toEqual({ returnUrl: 'https://return.me' });
    });

    it('omits the body when no returnUrl', async () => {
      server.use(
        http.post(`${API_BASE}/integrations/email/gmail/start`, () =>
          HttpResponse.json({ authUrl: 'https://g.com/auth' }),
        ),
      );
      const out = await startGmailOAuthApi();
      expect(out.authUrl).toBe('https://g.com/auth');
    });

    it('throws with payload error when non-OK', async () => {
      server.use(
        http.post(`${API_BASE}/integrations/email/gmail/start`, () =>
          HttpResponse.json({ error: 'scopes missing' }, { status: 400 }),
        ),
      );
      await expect(startGmailOAuthApi()).rejects.toThrow('scopes missing');
    });

    it('throws with default message when the API returns no authUrl', async () => {
      server.use(
        http.post(`${API_BASE}/integrations/email/gmail/start`, () =>
          HttpResponse.json({ ok: true }),
        ),
      );
      await expect(startGmailOAuthApi()).rejects.toThrow(/failed to start email connection/i);
    });
  });

  describe('sendPasswordRequestApi', () => {
    it('resolves when API returns 200', async () => {
      server.use(
        http.post(`${API_BASE}/integrations/passwords/request`, async ({ request }) => {
          const body = (await request.json()) as { request: string };
          expect(body.request).toBe('My Bank');
          return HttpResponse.json({ ok: true });
        }),
      );
      await expect(sendPasswordRequestApi('My Bank')).resolves.toBeUndefined();
    });

    it('throws payload error on non-OK', async () => {
      server.use(
        http.post(`${API_BASE}/integrations/passwords/request`, () =>
          HttpResponse.json({ error: 'nope' }, { status: 400 }),
        ),
      );
      await expect(sendPasswordRequestApi('x')).rejects.toThrow('nope');
    });

    it('throws default message on non-OK with unparseable body', async () => {
      server.use(
        http.post(
          `${API_BASE}/integrations/passwords/request`,
          () => new HttpResponse('<html>', { status: 500 }),
        ),
      );
      await expect(sendPasswordRequestApi('x')).rejects.toThrow(/failed to send request/i);
    });
  });

  describe('uploadApplePasswordsApi', () => {
    it('returns the payload on success', async () => {
      server.use(
        http.post(`${API_BASE}/integrations/passwords/apple/upload`, () =>
          HttpResponse.json({ passwordCount: 42 }),
        ),
      );
      const file = new File(['a,b'], 'p.csv', { type: 'text/csv' });
      const out = await uploadApplePasswordsApi(file);
      expect(out).toEqual({ passwordCount: 42 });
    });

    it('throws payload error on non-OK', async () => {
      server.use(
        http.post(`${API_BASE}/integrations/passwords/apple/upload`, () =>
          HttpResponse.json({ error: 'corrupt csv' }, { status: 400 }),
        ),
      );
      const file = new File(['x'], 'p.csv');
      await expect(uploadApplePasswordsApi(file)).rejects.toThrow('corrupt csv');
    });

    it('falls back to default message when body is unreadable', async () => {
      server.use(
        http.post(
          `${API_BASE}/integrations/passwords/apple/upload`,
          () => new HttpResponse(null, { status: 500 }),
        ),
      );
      const file = new File(['x'], 'p.csv');
      await expect(uploadApplePasswordsApi(file)).rejects.toThrow(/failed to import passwords/i);
    });

    it('throws when no session is set', async () => {
      localStorage.clear();
      const file = new File(['x'], 'p.csv');
      await expect(uploadApplePasswordsApi(file)).rejects.toThrow('Not authenticated');
    });
  });

  describe('createLinkedInSyncAgentApi', () => {
    it('creates a normal agent, then records it as the LinkedIn sync', async () => {
      let body: Record<string, unknown> = null;
      let recorded: Record<string, unknown> = null;
      server.use(
        http.post(`${API_BASE}/agents`, async ({ request }) => {
          body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ agent_id: 'a-1' }, { status: 201 });
        }),
        http.post(`${API_BASE}/integrations/linkedin/sync`, async ({ request }) => {
          recorded = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ status: 'SYNCING', agent_id: 'a-1' });
        }),
      );
      await expect(createLinkedInSyncAgentApi()).resolves.toBe('a-1');
      expect(body).toMatchObject({
        goal: expect.stringMatching(/LinkedIn/),
        source: 'WEB',
        start_phase: 'execute',
      });
      expect(body).not.toHaveProperty('depth');
      expect(body).not.toHaveProperty('price_limit_cents');
      expect(recorded).toEqual({ agent_id: 'a-1' });
    });

    it('surfaces a failed sync record', async () => {
      server.use(
        http.post(`${API_BASE}/agents`, () => HttpResponse.json({ agent_id: 'a-1' })),
        http.post(`${API_BASE}/integrations/linkedin/sync`, () =>
          HttpResponse.json({ error: 'LinkedIn sync already running' }, { status: 409 }),
        ),
      );
      await expect(createLinkedInSyncAgentApi()).rejects.toThrow('LinkedIn sync already running');
    });

    it('throws payload error on non-OK', async () => {
      server.use(
        http.post(`${API_BASE}/agents`, () =>
          HttpResponse.json({ error: 'quota exceeded' }, { status: 429 }),
        ),
      );
      await expect(createLinkedInSyncAgentApi()).rejects.toThrow('quota exceeded');
    });

    it('throws default message when error field missing', async () => {
      server.use(http.post(`${API_BASE}/agents`, () => HttpResponse.json({}, { status: 500 })));
      await expect(createLinkedInSyncAgentApi()).rejects.toThrow(/failed to create agent/i);
    });
  });
});
