import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import Integrations from '@/pages/Integrations';
import IPhoneConnectionSection from '@/features/integrations/components/IPhoneConnectionSection';
import { mockTerminalHookSession } from './terminal-hooks.fixtures';

const API = 'http://localhost:3001/api';
const AGENT = '00000000-0000-4000-8000-000000000801';
function backend(initial = 'not_connected', enabled = true, configured = true) {
  const state = {
    status: initial,
    enabled,
    configured,
    setupAgentId: null as string | null,
    connectionRevision: 1,
    posts: [] as Record<string, unknown>[],
  };
  const dto = () => ({
    enabled: state.enabled,
    configured: state.configured,
    status: state.status,
    setupAgentId: state.setupAgentId,
    connectionRevision: state.connectionRevision,
  });
  server.use(
    http.get(`${API}/integrations`, () => HttpResponse.json({ integrations: [] })),
    http.get(`${API}/iphone/connection`, () => HttpResponse.json(dto())),
    http.post(`${API}/iphone/connect`, async ({ request }) => {
      state.posts.push((await request.json()) as Record<string, unknown>);
      state.status = 'setting_up';
      state.setupAgentId = AGENT;
      return HttpResponse.json(dto());
    }),
  );
  return state;
}

beforeEach(() => mockTerminalHookSession());
afterEach(() => localStorage.clear());

describe('iPhone connection in normal Integrations', () => {
  it.each([false, true])(
    'renders the Apple iPhone entry with desktop flag %s',
    async (roseDesktop) => {
      backend();
      renderWithProviders(<Integrations />, { roseDesktop });
      expect(await screen.findByRole('button', { name: 'Connect iPhone' })).toBeEnabled();
      const row = screen.getByRole('region', { name: 'iPhone connection' });
      expect(within(row).getByTestId('iphone-apple-icon')).toBeInTheDocument();
    },
  );

  it('disabled accounts get the contact instruction and cannot start setup', async () => {
    const state = backend('not_connected', false, false);
    renderWithProviders(<Integrations />, { roseDesktop: false });
    await userEvent.click(await screen.findByRole('button', { name: 'Connect iPhone' }));
    expect(await screen.findByRole('link', { name: 'andy@roselabs.ai' })).toHaveAttribute(
      'href',
      'mailto:andy@roselabs.ai',
    );
    expect(state.posts).toEqual([]);
  });

  it('starts one normal owned setup and opens its regular agent link', async () => {
    const state = backend();
    renderWithProviders(<Integrations />, { roseDesktop: false });
    await userEvent.dblClick(await screen.findByRole('button', { name: 'Connect iPhone' }));
    expect(await screen.findByText('Setting up')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Open iPhone setup' })).toHaveAttribute(
      'href',
      `/?agent-id=${AGENT}`,
    );
    expect(state.posts).toHaveLength(1);
    expect(Object.keys(state.posts[0]).sort()).toEqual(['expectedRevision', 'requestKey']);
    expect(state.posts[0].expectedRevision).toBe(1);
    expect(typeof state.posts[0].requestKey).toBe('string');
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
    state.status = 'ready';
    window.dispatchEvent(new Event('focus'));
    expect(await screen.findByText('Connected')).toBeInTheDocument();
  });

  it('reflects trusted sign-out as Needs reauth and reconnects through the same setup flow', async () => {
    const state = backend('ready');
    renderWithProviders(<Integrations />, { roseDesktop: true });
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    state.status = 'needs_reauth';
    state.connectionRevision = 2;
    window.dispatchEvent(new Event('focus'));
    expect(await screen.findByText('Needs reauth')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect iPhone' }));
    await waitFor(() => expect(state.posts).toHaveLength(1));
    expect(state.posts[0].expectedRevision).toBe(2);
    expect(await screen.findByText('Setting up')).toBeInTheDocument();
  });

  it('does not display Connected for an unconfigured ready claim', async () => {
    backend('ready', true, false);
    renderWithProviders(<Integrations />, { roseDesktop: false });
    expect(await screen.findByText('Unable to load iPhone connection.')).toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });

  it('keeps reauthentication visible when the server rejects a stale reconnect revision', async () => {
    backend('needs_reauth');
    let submitted: Record<string, unknown> | null = null;
    server.use(
      http.post(`${API}/iphone/connect`, async ({ request }) => {
        submitted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ error: 'connection changed' }, { status: 409 });
      }),
    );
    renderWithProviders(<Integrations />, { roseDesktop: false });
    await userEvent.click(await screen.findByRole('button', { name: 'Reconnect iPhone' }));
    expect(await screen.findByText('Unable to connect iPhone. Try again.')).toBeInTheDocument();
    expect(submitted?.expectedRevision).toBe(1);
    expect(screen.getByText('Needs reauth')).toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });

  it('aborts an old account read and cannot publish its setup link into the next account', async () => {
    let release: (() => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    let reads = 0;
    server.use(
      http.get(`${API}/iphone/connection`, async ({ request }) => {
        reads += 1;
        if (reads === 1) {
          oldSignal = request.signal;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return HttpResponse.json({
            enabled: true,
            configured: true,
            status: 'setting_up',
            setupAgentId: AGENT,
            connectionRevision: 99,
          });
        }
        return HttpResponse.json({
          enabled: false,
          configured: false,
          status: 'not_connected',
          setupAgentId: null,
          connectionRevision: 0,
        });
      }),
    );
    const view = renderWithProviders(<IPhoneConnectionSection key="account-a" />);
    await waitFor(() => expect(release).toBeDefined());
    view.rerender(<IPhoneConnectionSection key="account-b" />);
    expect(await screen.findByRole('link', { name: 'andy@roselabs.ai' })).toBeInTheDocument();
    expect(oldSignal?.aborted).toBe(true);
    release?.();
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.queryByRole('link', { name: 'Open iPhone setup' })).not.toBeInTheDocument();
  });

  it('lets the user retry a failed account-status read without granting local readiness', async () => {
    const state = backend();
    let reads = 0;
    server.use(
      http.get(`${API}/iphone/connection`, () => {
        reads += 1;
        return reads === 1
          ? HttpResponse.json({ error: 'temporary failure' }, { status: 503 })
          : HttpResponse.json({
              enabled: true,
              configured: true,
              status: 'not_connected',
              setupAgentId: null,
              connectionRevision: 1,
            });
      }),
    );
    renderWithProviders(<Integrations />, { roseDesktop: false });
    expect(await screen.findByText('Unable to load iPhone connection.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect iPhone' }));
    expect(await screen.findByText('Setting up')).toBeInTheDocument();
    expect(state.posts).toHaveLength(1);
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });
});
