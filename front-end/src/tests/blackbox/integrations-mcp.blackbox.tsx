/**
 * Blackbox tests for MCP servers on the Integrations page (stock cards and the
 * Rose Desktop list), its OAuth callback page, and the CLI card's placeholder.
 *
 *   - the list renders name, URL host and status (tool count, sign-in, error)
 *   - connect without auth POSTs the URL and this origin's callback, no headers
 *   - an "API key header" value is sent as "Authorization: Bearer <value>"
 *   - a connect returning authorize_url sends the browser to sign-in
 *   - × removes a server; Sign in on a needs_auth row reconnects
 *   - callback page posts code+state and returns to the remembered page
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import Integrations from '@/pages/Integrations';
import { McpCallback } from '@/features/integrations/components';
import { MCP_SIGN_IN_POLL_MS } from '@/features/integrations/hooks/useMcpServers';
import { mockTerminalHookSession as mockSession } from './terminal-hooks.fixtures';

const API_BASE = 'http://localhost:3001/api';

const context7 = {
  id: 'mcp-1',
  name: 'Context7',
  url: 'https://mcp.context7.com/mcp',
  auth: 'none',
  status: 'connected',
  tools: [
    { name: 'resolve-library-id', description: 'Resolve' },
    { name: 'get-library-docs', description: 'Docs' },
  ],
  error: null,
} as const;
const linear = {
  id: 'mcp-2',
  name: 'Linear',
  url: 'https://mcp.linear.app/sse',
  auth: 'oauth',
  status: 'needs_auth',
  tools: [],
  error: null,
} as const;
const broken = {
  id: 'mcp-3',
  name: 'Broken',
  url: 'https://broken.example.com/mcp',
  auth: 'headers',
  status: 'failed',
  tools: [],
  error: 'Server returned 401',
} as const;

describe.each([false, true])('MCP servers (desktop=%s)', (roseDesktop) => {
  const originalLocation = window.location;

  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    mockSession();
    server.use(
      http.get(`${API_BASE}/integrations`, () => HttpResponse.json({ integrations: [] })),
      http.get(`${API_BASE}/compute-accounts`, () => HttpResponse.json({ accounts: [] })),
    );
  });
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  async function section() {
    return within(await screen.findByRole('region', { name: 'MCP servers' }));
  }

  function captureConnect(response: (body: Record<string, unknown>) => Response) {
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.post(`${API_BASE}/integrations/mcp`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        return response(body);
      }),
    );
    return bodies;
  }

  it('lists servers with host, tool count, sign-in and error states', async () => {
    server.use(
      http.get(`${API_BASE}/integrations/mcp`, () =>
        HttpResponse.json({ servers: [context7, linear, broken] }),
      ),
    );
    renderWithProviders(<Integrations />, { roseDesktop });
    const card = await section();
    expect(await card.findByText('Context7')).toBeVisible();
    expect(card.getByText('mcp.context7.com')).toBeVisible();
    expect(card.getByText('Connected · 2 tools')).toBeVisible();
    expect(card.getByText('Sign in required')).toBeVisible();
    expect(card.getByRole('button', { name: 'Sign in Linear' })).toBeVisible();
    expect(card.getByText('Server returned 401')).toBeVisible();
    expect(card.getByRole('button', { name: 'Reconnect Broken' })).toBeVisible();
    expect(card.getByText('1 server connected')).toBeVisible();
  });

  it('connects a server without auth and lists it', async () => {
    const bodies = captureConnect(() => HttpResponse.json({ server: context7 }, { status: 201 }));
    renderWithProviders(<Integrations />, { roseDesktop });
    const card = await section();
    const user = userEvent.setup();
    const input = card.getByLabelText('MCP server URL');
    expect(input).toHaveAttribute('placeholder', 'https://mcp.context7.com/mcp');
    await user.type(input, 'https://mcp.context7.com/mcp');
    await user.click(card.getByRole('button', { name: 'Connect MCP server' }));
    expect(await card.findByText('Connected · 2 tools')).toBeVisible();
    expect(bodies).toEqual([
      {
        url: 'https://mcp.context7.com/mcp',
        redirect_uri: `${window.location.origin}/integrations/mcp/callback`,
      },
    ]);
    expect(input).toHaveValue('');
  });

  it('sends a filled API key header as a Bearer Authorization header', async () => {
    const bodies = captureConnect(() =>
      HttpResponse.json({ server: { ...broken, status: 'connected', error: null } }),
    );
    renderWithProviders(<Integrations />, { roseDesktop });
    const card = await section();
    const user = userEvent.setup();
    await user.type(card.getByLabelText('MCP server URL'), 'https://broken.example.com/mcp');
    await user.click(card.getByRole('button', { name: /API key header/ }));
    expect(card.getByLabelText('Header name')).toHaveValue('Authorization');
    await user.type(card.getByLabelText('Header value'), 'sk-123');
    await user.click(card.getByRole('button', { name: 'Connect MCP server' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].headers).toEqual({ Authorization: 'Bearer sk-123' });
  });

  it('sends the browser to OAuth sign-in when the server returns authorize_url', async () => {
    const authorizeUrl = 'https://mcp.linear.app/authorize?client_id=c&state=s';
    captureConnect(() =>
      HttpResponse.json({ server: linear, authorize_url: authorizeUrl }, { status: 201 }),
    );
    const location = { ...originalLocation, href: originalLocation.href };
    Object.defineProperty(window, 'location', { configurable: true, value: location });
    renderWithProviders(<Integrations />, { roseDesktop });
    const card = await section();
    const user = userEvent.setup();
    await user.type(card.getByLabelText('MCP server URL'), 'https://mcp.linear.app/sse');
    await user.click(card.getByRole('button', { name: 'Connect MCP server' }));
    await waitFor(() => expect(location.href).toBe(authorizeUrl));
    expect(sessionStorage.getItem('rose.mcp.returnPath')).toBe(
      originalLocation.pathname + originalLocation.search,
    );
  });

  it('desktop app signs in through the system browser and polls until connected', async () => {
    const authorizeUrl = 'https://mcp.linear.app/authorize?client_id=c&state=s';
    const bodies = captureConnect(() =>
      HttpResponse.json({ server: linear, authorize_url: authorizeUrl }, { status: 201 }),
    );
    const openExternal = vi.fn(async () => undefined);
    window.api = { isElectron: true, openExternal };
    let listed = 0;
    server.use(
      http.get(`${API_BASE}/integrations/mcp`, () => {
        listed += 1;
        // First load: empty; polls after sign-in see the server connected.
        return HttpResponse.json({
          servers: listed === 1 ? [] : [{ ...linear, status: 'connected', tools: context7.tools }],
        });
      }),
    );
    // Only the sign-in poll interval is faked; userEvent and msw keep real timers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      renderWithProviders(<Integrations />, { roseDesktop });
      const card = await section();
      const user = userEvent.setup();
      await user.type(card.getByLabelText('MCP server URL'), 'https://mcp.linear.app/sse');
      await user.click(card.getByRole('button', { name: 'Connect MCP server' }));
      await waitFor(() => expect(openExternal).toHaveBeenCalledWith(authorizeUrl));
      expect(bodies[0].redirect_uri).toBe('https://www.roselabs.ai/integrations/mcp/callback');
      await vi.advanceTimersByTimeAsync(MCP_SIGN_IN_POLL_MS);
      expect(await card.findByText('Connected · 2 tools')).toBeVisible();
      expect(listed).toBe(2);
    } finally {
      vi.useRealTimers();
      delete window.api;
    }
  });

  it('desktop app shows an error when the system browser cannot open', async () => {
    const authorizeUrl = 'https://mcp.linear.app/authorize?client_id=c&state=s';
    captureConnect(() =>
      HttpResponse.json({ server: linear, authorize_url: authorizeUrl }, { status: 201 }),
    );
    const openExternal = vi.fn(async () => ({ success: false }));
    window.api = { isElectron: true, openExternal };
    try {
      renderWithProviders(<Integrations />, { roseDesktop });
      const card = await section();
      const user = userEvent.setup();
      const input = card.getByLabelText('MCP server URL');
      await user.type(input, 'https://mcp.linear.app/sse');
      await user.click(card.getByRole('button', { name: 'Connect MCP server' }));
      expect(await card.findByText(/Could not open your browser to sign in/)).toBeVisible();
      expect(input).toHaveValue('https://mcp.linear.app/sse');
    } finally {
      delete window.api;
    }
  });

  it('removes a server with ×', async () => {
    const deleted: string[] = [];
    server.use(
      http.get(`${API_BASE}/integrations/mcp`, () => HttpResponse.json({ servers: [context7] })),
      http.delete(`${API_BASE}/integrations/mcp/:id`, ({ params }) => {
        deleted.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithProviders(<Integrations />, { roseDesktop });
    const card = await section();
    const user = userEvent.setup();
    await user.click(await card.findByRole('button', { name: 'Remove Context7' }));
    await waitFor(() => expect(card.queryByText('Context7')).not.toBeInTheDocument());
    expect(deleted).toEqual(['mcp-1']);
  });

  it('Sign in on a needs_auth row reconnects with this origin callback', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.get(`${API_BASE}/integrations/mcp`, () => HttpResponse.json({ servers: [linear] })),
      http.post(`${API_BASE}/integrations/mcp/:id/reconnect`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ server: { ...linear, status: 'connected' } });
      }),
    );
    renderWithProviders(<Integrations />, { roseDesktop });
    const card = await section();
    const user = userEvent.setup();
    await user.click(await card.findByRole('button', { name: 'Sign in Linear' }));
    expect(await card.findByText('Connected · 0 tools')).toBeVisible();
    expect(bodies).toEqual([
      { redirect_uri: `${window.location.origin}/integrations/mcp/callback` },
    ]);
  });

  it('CLI card uses the integration card look and the YC placeholder', async () => {
    renderWithProviders(<Integrations />, { roseDesktop });
    const cli = within(await screen.findByRole('region', { name: 'CLIs' }));
    expect(cli.getByText('Connect command-line tools for your agents')).toBeVisible();
    await userEvent.setup().click(cli.getByRole('button', { name: 'Add CLI' }));
    expect(cli.getByLabelText('Enter the CLI you want to connect')).toHaveAttribute(
      'placeholder',
      'e.g. YC (Y Combinator) CLI',
    );
  });
});

describe('MCP sign-in callback page', () => {
  const originalLocation = window.location;

  function at(search: string) {
    const replace = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, search, replace },
    });
    return replace;
  }

  beforeEach(() => mockSession());
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('completes sign-in with the code and state and returns to the starting page', async () => {
    const completes: unknown[] = [];
    server.use(
      http.post(`${API_BASE}/integrations/mcp/oauth/complete`, async ({ request }) => {
        completes.push(await request.json());
        return HttpResponse.json({ server: { ...linear, status: 'connected' } });
      }),
    );
    sessionStorage.setItem('rose.mcp.returnPath', '/?view=integrations');
    const replace = at('?code=abc&state=user.nonce');
    renderWithProviders(<McpCallback />, { roseDesktop: false });
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/?view=integrations'));
    expect(completes).toEqual([{ code: 'abc', state: 'user.nonce' }]);
    expect(sessionStorage.getItem('rose.mcp.returnPath')).toBeNull();
  });

  it('shows a refused sign-in and stays on the page', async () => {
    server.use(
      http.post(`${API_BASE}/integrations/mcp/oauth/complete`, () =>
        HttpResponse.json({ error: 'Unknown or expired MCP sign-in' }, { status: 400 }),
      ),
    );
    const replace = at('?code=abc&state=other.nonce');
    renderWithProviders(<McpCallback />, { roseDesktop: false });
    expect(await screen.findByText('Unknown or expired MCP sign-in')).toBeVisible();
    expect(replace).not.toHaveBeenCalled();
  });
});
