/**
 * Blackbox: the Browser drawer for a selected agent WITHOUT a browser task shows
 * "No browser session" — never the user's Root cloud browser, and nothing opens
 * a cloud browser by itself (Andy, 2026-10-28: "dont render a random cloud
 * browser"). Root shows only on an explicit Root click; "Open browser" then
 * starts at the agent tree's default_url. An agent with an active browser task
 * still shows its own live view.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { RoseAppIcons } from '@/features/terminal-component-group/components/rose-apps/RoseAppIcons';
import type { RootBrowserView } from '@/lib/api/browser-world';

import { capturedRequests } from './msw/capture';
import { server } from './msw/server';
import {
  ROOT,
  WORLD,
  WRAPPER_CLASS,
  agentBrowser,
  boundRootFrame,
  openBrowserDrawer,
  serveRoot,
  settle,
  worldRequests,
} from './rose-apps-root-browser.fixtures';
import { renderWithProviders } from './test-wrapper';
import { mockTerminalHookSession as mockSession } from './terminal-hooks.fixtures';

describe('Browser drawer: an agent without a browser never shows a cloud browser', () => {
  const AGENT = 'agent-root-1';
  const DEFAULT_URL = 'https://www.opentable.com/r/nopa-san-francisco';

  beforeEach(() => mockSession());
  afterEach(() => localStorage.clear());

  /** GET /root answers default_url only for `?agent_id=`; POST /root/open is recorded. */
  function serveDefaultUrl(options: { defaultUrl: string | null; root?: RootBrowserView }) {
    const reads: (string | null)[] = [];
    const opened: unknown[] = [];
    let root: RootBrowserView | null = options.root ?? null;
    serveRoot(() => root);
    server.use(
      http.get(`${WORLD}/root`, ({ request }) => {
        const agentId = new URL(request.url).searchParams.get('agent_id');
        reads.push(agentId);
        const defaultUrl = agentId === null ? null : options.defaultUrl;
        return HttpResponse.json({ root, sites: [], default_url: defaultUrl });
      }),
      http.post(`${WORLD}/root/open`, async ({ request }) => {
        opened.push(await request.json());
        root = ROOT;
        return HttpResponse.json({ root: ROOT });
      }),
      http.post(`${WORLD}/root/close`, () => {
        root = null;
        return HttpResponse.json({ root: null, world_state: null });
      }),
    );
    return { reads, opened };
  }

  function renderWithAgent(selectedAgentId: string | null, roseDesktop = true) {
    return renderWithProviders(<RoseAppIcons />, { roseDesktop, selectedAgentId });
  }

  /** The selected agent has no browser task: the drawer shows NO_SESSION, never a browser. */
  async function expectNoSession(drawer: HTMLElement) {
    const empty = await within(drawer).findByTestId('browser-no-session');
    expect(empty).toHaveTextContent('No browser session');
    expect(empty.className).not.toMatch(WRAPPER_CLASS);
    expect(drawer.querySelector('iframe')).toBeNull();
    expect(within(drawer).queryByTestId('root-browser-pane')).toBeNull();
    expect(within(drawer).queryByTestId('root-browser-empty')).toBeNull();
    expect(within(drawer).queryByTestId('browser-chrome')).toBeNull();
    expect(within(drawer).getByTestId('browser-tab-root')).toHaveAttribute(
      'aria-selected',
      'false',
    );
  }

  it('an agent without a browser shows No browser session: no Root read, open or frame', async () => {
    const backend = serveDefaultUrl({ defaultUrl: DEFAULT_URL });
    const user = userEvent.setup();
    renderWithAgent(AGENT);
    await settle();
    expect(worldRequests()).toEqual([]);

    const drawer = await openBrowserDrawer(user);
    await expectNoSession(drawer);
    await settle();
    // No cloud browser starts on its own and the user's Root is never borrowed.
    expect(backend.reads).toEqual([]);
    expect(backend.opened).toEqual([]);
    expect(drawer.querySelector('iframe')).toBeNull();
  });

  it('an already open Root is not shown in place of an agent without a browser', async () => {
    const backend = serveDefaultUrl({ defaultUrl: DEFAULT_URL, root: ROOT });
    const user = userEvent.setup();
    renderWithAgent(AGENT);
    const drawer = await openBrowserDrawer(user);
    await expectNoSession(drawer);
    await settle();
    expect(drawer.querySelector('iframe')).toBeNull();
    expect(backend.opened).toEqual([]);

    // Only an explicit Root click shows the user's own browser, as is.
    await user.click(within(drawer).getByTestId('browser-tab-root'));
    await boundRootFrame(await within(drawer).findByTestId('root-browser-pane'));
    expect(within(drawer).queryByTestId('browser-no-session')).toBeNull();
    await settle();
    expect(backend.opened).toEqual([]);
  });

  it('an explicit Root click stays quiet; Open browser starts at the tree default_url', async () => {
    const backend = serveDefaultUrl({ defaultUrl: DEFAULT_URL });
    const user = userEvent.setup();
    renderWithAgent(AGENT);
    const drawer = await openBrowserDrawer(user);
    await expectNoSession(drawer);
    await user.click(within(drawer).getByTestId('browser-tab-root'));
    const open = await within(drawer).findByRole('button', { name: 'Open browser' });
    await settle();
    expect(backend.reads).toEqual([AGENT]);
    expect(backend.opened).toEqual([]);
    expect(drawer.querySelector('iframe')).toBeNull();

    await user.click(open);
    await boundRootFrame(await within(drawer).findByTestId('root-browser-pane'));
    expect(backend.opened).toEqual([{ start_url: DEFAULT_URL }]);
  });

  it('reopening the drawer for the same agent returns to No browser session', async () => {
    serveDefaultUrl({ defaultUrl: DEFAULT_URL, root: ROOT });
    const user = userEvent.setup();
    renderWithAgent(AGENT);
    let drawer = await openBrowserDrawer(user);
    await user.click(within(drawer).getByTestId('browser-tab-root'));
    await within(drawer).findByTestId('root-browser-pane');
    await user.click(screen.getByTestId('rose-app-browser'));
    expect(screen.getByTestId('browser-app-drawer')).toHaveAttribute('data-state', 'closed');
    drawer = await openBrowserDrawer(user);
    await expectNoSession(drawer);
  });

  it('with no agent selected it shows the quiet Open browser and opens nothing by itself', async () => {
    const backend = serveDefaultUrl({ defaultUrl: DEFAULT_URL });
    const user = userEvent.setup();
    renderWithAgent(null);
    const drawer = await openBrowserDrawer(user);
    const open = await within(drawer).findByRole('button', { name: 'Open browser' });
    await settle();
    expect(backend.reads).toEqual([null]);
    expect(backend.opened).toEqual([]);
    expect(within(drawer).getByTestId('root-browser-empty')).toHaveTextContent('Your browser');
    expect(within(drawer).queryByTestId('browser-no-session')).toBeNull();

    await user.click(open);
    await within(drawer).findByTestId('root-browser-pane');
    expect(backend.opened).toEqual([{}]);
  });

  it('closing an opened Root does not reopen it; closing the drawer stops all reads', async () => {
    const backend = serveDefaultUrl({ defaultUrl: null });
    const user = userEvent.setup();
    renderWithAgent(AGENT);
    const drawer = await openBrowserDrawer(user);
    await user.click(within(drawer).getByTestId('browser-tab-root'));
    await user.click(await within(drawer).findByRole('button', { name: 'Open browser' }));
    const pane = await within(drawer).findByTestId('root-browser-pane');
    expect(backend.opened).toEqual([{}]);
    await user.click(within(pane).getByRole('button', { name: 'Close browser' }));
    await within(drawer).findByRole('button', { name: 'Open browser' });
    await settle();
    expect(backend.opened).toHaveLength(1);

    await user.click(screen.getByTestId('rose-app-browser'));
    expect(screen.getByTestId('browser-app-drawer')).toHaveAttribute('data-state', 'closed');
    const before = capturedRequests.length;
    await settle();
    expect(capturedRequests.slice(before).filter((r) => r.url.includes('/browser-world/'))).toEqual(
      [],
    );
  });

  it('an agent with an active browser task shows its own browser, not No browser session', async () => {
    serveDefaultUrl({ defaultUrl: DEFAULT_URL, root: ROOT });
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <RoseAppIcons />
        {agentBrowser(AGENT)}
      </>,
      { selectedAgentId: AGENT },
    );
    const drawer = await openBrowserDrawer(user);
    await waitFor(() =>
      expect(within(drawer).getByTestId(`browser-tab-${AGENT}`)).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    expect(within(drawer).queryByTestId('browser-no-session')).toBeNull();
    expect(within(drawer).queryByTestId('root-browser-pane')).toBeNull();
    const slot = within(drawer).getByTestId('browser-drawer-slot');
    await waitFor(() => expect(slot.querySelector('iframe')).not.toBeNull());
  });

  it('flag off: an agent selected and the drawer opened reads and opens nothing', async () => {
    const backend = serveDefaultUrl({ defaultUrl: DEFAULT_URL });
    const user = userEvent.setup();
    renderWithAgent(AGENT, false);
    await user.click(screen.getByTestId('rose-app-browser'));
    await settle();
    expect(backend.reads).toEqual([]);
    expect(backend.opened).toEqual([]);
  });
});
