/**
 * iPhone integration row (Integrations page) + Connect → Phone app device view.
 *
 *  - the row is a normal integration row (shared row/header/action classes)
 *  - Connect posts once, then opens the Phone app in device view (boot-up visible)
 *  - setup progress fills by completed steps; each step is listed on the phone;
 *    ready stops the fast /connection polling
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import Integrations from '@/pages/Integrations';
import IPhoneConnectionSection from '@/features/integrations/components/IPhoneConnectionSection';
import { mockTerminalHookSession } from './terminal-hooks.fixtures';
import { capturedRequests } from './msw/capture';

const API = 'http://localhost:3001/api';
const AGENT = '00000000-0000-4000-8000-000000000801';
const STEPS = [
  ['session', 'Phone booted'],
  ['portrait_lock', 'Orientation locked'],
  ['apple_account', 'Apple ID signed in'],
  ['icloud', 'iCloud connected'],
  ['imessage', 'iMessage on'],
  ['gmail', 'Gmail connected'],
  ['passcode', 'Passcode set'],
] as const;
/** The first `done` steps are done, the next one is running, the rest are pending. */
const steps = (done: number) =>
  STEPS.map(([key, label], index) => ({
    key,
    label,
    status: index < done ? 'done' : index === done ? 'in_progress' : 'pending',
  }));
function backend(initial = 'not_connected', enabled = true, configured = true) {
  const state = {
    status: initial,
    enabled,
    configured,
    setupAgentId: null as string | null,
    connectionRevision: 1,
    steps: null as ReturnType<typeof steps> | null,
    reads: 0,
    posts: [] as Record<string, unknown>[],
    providerState: 'STARTING',
  };
  const dto = () => ({
    enabled: state.enabled,
    configured: state.configured,
    status: state.status,
    setupAgentId: state.setupAgentId,
    connectionRevision: state.connectionRevision,
    setupProgress: state.steps === null ? null : { steps: state.steps },
    setupTaskId: state.setupAgentId === null ? null : 'setup-task',
  });
  server.use(
    http.get(`${API}/integrations`, () => HttpResponse.json({ integrations: [] })),
    http.get(`${API}/iphone/connection`, () => {
      state.reads += 1;
      return HttpResponse.json(dto());
    }),
    http.post(`${API}/iphone/connect`, async ({ request }) => {
      state.posts.push((await request.json()) as Record<string, unknown>);
      state.status = 'setting_up';
      state.setupAgentId = AGENT;
      state.steps = steps(0);
      return HttpResponse.json(dto());
    }),
    http.get(`${API}/iphone/device`, () =>
      HttpResponse.json({
        enabled: true,
        setupState: state.status,
        providerState: state.providerState,
        holder: { agentId: AGENT, leaseId: 'setup-lease', controlOwner: 'agent', since: '' },
        waiting: [],
      }),
    ),
    http.get(`${API}/iphone/device/frame`, () =>
      HttpResponse.json({ error: 'not ready', state: state.providerState }, { status: 409 }),
    ),
  );
  return state;
}
const leaseOrQueueRequests = () =>
  capturedRequests.filter((r) => /\/(leases|interactions)\//.test(new URL(r.url).pathname));

beforeEach(() => mockTerminalHookSession());
afterEach(() => localStorage.clear());

describe('iPhone connection in normal Integrations', () => {
  it.each([false, true])(
    'renders the Apple iPhone entry as an integration row with desktop flag %s',
    async (roseDesktop) => {
      backend();
      renderWithProviders(<Integrations />, { roseDesktop });
      const connect = await screen.findByRole('button', { name: 'Connect iPhone' });
      expect(connect).toBeEnabled();
      expect(connect).toHaveTextContent(/^Connect$/);
      const section = screen.getByRole('region', { name: 'iPhone connection' });
      expect(within(section).getByRole('heading', { name: 'iPhone' })).toBeInTheDocument();
      const row = within(section).getByTestId('integration-row-iphone');
      expect(within(row).getByTestId('iphone-apple-icon')).toBeInTheDocument();
      expect(row).toContainElement(connect);
    },
  );

  it('uses the exact row, header, name and action styling of the other integration rows', async () => {
    backend();
    renderWithProviders(<Integrations />, { roseDesktop: true });
    const connect = await screen.findByRole('button', { name: 'Connect iPhone' });
    const row = screen.getByTestId('integration-row-iphone');
    const other = (await screen.findAllByTestId(/^integration-row-/)).find(
      (candidate) =>
        candidate !== row && within(candidate).queryByRole('button', { name: /^Connect / }),
    );
    expect(other).toBeDefined();
    expect(row.className).toBe(other!.className);
    expect(connect.className).toBe(
      within(other!).getByRole('button', { name: /^Connect / }).className,
    );
    const name = within(row).getByText('iPhone');
    const otherName = other!.querySelector('span.truncate');
    expect(name.className).toBe(otherName?.className);
    const headers = screen.getAllByRole('heading', { level: 3 });
    const iphoneHeader = within(
      screen.getByRole('region', { name: 'iPhone connection' }),
    ).getByRole('heading');
    expect(headers.find((h) => h !== iphoneHeader)?.className).toBe(iphoneHeader.className);
    // No separate bordered card around the iPhone entry.
    expect(screen.getByRole('region', { name: 'iPhone connection' }).className).not.toMatch(
      /border|rounded|bg-card/,
    );
  });

  it('disabled accounts get the contact instruction and cannot start setup', async () => {
    const state = backend('not_connected', false, false);
    renderWithProviders(<Integrations />, { roseDesktop: false });
    expect(await screen.findByRole('link', { name: 'andy@roselabs.ai' })).toHaveAttribute(
      'href',
      'mailto:andy@roselabs.ai',
    );
    expect(screen.queryByRole('button', { name: 'Connect iPhone' })).toBeNull();
    expect(state.posts).toEqual([]);
  });

  it('Connect posts once, then opens the Phone app in device view to watch boot-up', async () => {
    const state = backend();
    renderWithProviders(<Integrations />, { roseDesktop: true });
    expect(screen.queryByTestId('rose-phone')).toBeNull();
    await userEvent.dblClick(await screen.findByRole('button', { name: 'Connect iPhone' }));
    const phone = await screen.findByTestId('rose-phone');
    const view = within(phone).getByTestId('phone-device-view');
    expect(view).toHaveAttribute('data-amp-block');
    expect(await within(view).findByText('Booting the phone…')).toBeInTheDocument();
    expect(await within(view).findByTestId('iphone-setup-progress-floating')).toBeInTheDocument();
    expect(within(view).getByTestId('phone-device-holder')).toHaveTextContent(
      'In use by agent 00000000',
    );
    expect(state.posts).toHaveLength(1);
    expect(
      within(screen.getByTestId('integration-row-iphone')).getByText('Setting up…'),
    ).toBeVisible();
    expect(leaseOrQueueRequests()).toEqual([]);
  });

  it('fills the setup bar by completed steps, lists each step on the phone, and stops fast polling when ready', async () => {
    const state = backend('setting_up');
    state.setupAgentId = AGENT;
    state.steps = steps(1);
    renderWithProviders(<Integrations />, { roseDesktop: true });
    const row = await screen.findByTestId('integration-row-iphone');
    const inline = await within(row).findByRole('progressbar', { name: 'iPhone setup progress' });
    expect(inline).toHaveAttribute('aria-valuenow', '14');
    expect(within(row).getByTestId('iphone-setup-progress-text')).toHaveTextContent(
      'Setting up · 1 of 7 steps',
    );
    await userEvent.click(within(row).getByRole('button', { name: 'View iPhone' }));
    const phone = await screen.findByTestId('rose-phone');
    const card = await within(phone).findByTestId('iphone-setup-progress-floating');
    const step = (key: string) => within(card).getByTestId(`iphone-setup-step-${key}`);
    expect(step('session')).toHaveAttribute('data-status', 'done');
    expect(step('portrait_lock')).toHaveAttribute('data-status', 'in_progress');
    expect(step('passcode')).toHaveAttribute('data-status', 'pending');
    for (const [, label] of STEPS) expect(card).toHaveTextContent(label);

    state.steps = steps(3);
    await waitFor(
      () => expect(within(card).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '43'),
      { timeout: 5000 },
    );
    expect(step('icloud')).toHaveAttribute('data-status', 'in_progress');
    expect(inline).toHaveAttribute('aria-valuenow', '43');

    state.status = 'ready';
    state.steps = steps(STEPS.length);
    await waitFor(() => expect(within(row).getByText('Connected')).toBeInTheDocument(), {
      timeout: 5000,
    });
    await waitFor(() => expect(card).toHaveTextContent('Connected'));
    expect(step('passcode')).toHaveAttribute('data-status', 'done');
    expect(within(row).queryByRole('progressbar')).toBeNull();
    const reads = state.reads;
    await new Promise((resolve) => setTimeout(resolve, 3200));
    expect(state.reads).toBe(reads);
  }, 20_000);

  it('starts one normal owned setup and opens its regular agent link with the flag off', async () => {
    const state = backend();
    renderWithProviders(<Integrations />, { roseDesktop: false });
    await userEvent.dblClick(await screen.findByRole('button', { name: 'Connect iPhone' }));
    expect(await screen.findByText('Setting up…')).toBeInTheDocument();
    expect(screen.queryByTestId('rose-phone')).toBeNull();
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
    expect(await screen.findByText('Setting up…')).toBeInTheDocument();
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
    expect(await screen.findByText('Setting up…')).toBeInTheDocument();
    expect(state.posts).toHaveLength(1);
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });
});
