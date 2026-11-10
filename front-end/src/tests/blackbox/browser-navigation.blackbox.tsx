import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { RoseAppIcons } from '@/features/terminal-component-group/components/rose-apps/RoseAppIcons';
import { renderWithProviders } from './test-wrapper';
import { mockTerminalHookSession } from './terminal-hooks.fixtures';
import { server } from './msw/server';
import {
  API,
  ROOT,
  agentBrowser,
  openBrowserDrawer,
  serveRoot,
} from './rose-apps-root-browser.fixtures';

function serveNavigation(status = 200) {
  const calls: string[] = [];
  server.use(
    http.post(`${API}/browser-session/task/:taskId/control`, async ({ params, request }) => {
      const body = (await request.json()) as { mode: string };
      calls.push(`${String(params.taskId)}:${body.mode}`);
      return HttpResponse.json({ state: 'user', agentPaused: false, debugUrl: ROOT.live_view_url });
    }),
    http.post(`${API}/browser-session/task/:taskId/navigation`, async ({ params, request }) => {
      const body = (await request.json()) as { action: string };
      calls.push(`${String(params.taskId)}:${body.action}`);
      return status === 200
        ? HttpResponse.json({ url: `https://example.com/${body.action}` })
        : HttpResponse.json({ error: 'Browser navigation failed' }, { status });
    }),
  );
  return calls;
}

describe('Browser drawer navigation', () => {
  beforeEach(() => mockTerminalHookSession());

  it('takes control then navigates the live Root browser backward and forward', async () => {
    serveRoot(() => ROOT);
    const calls = serveNavigation();
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />);
    const drawer = await openBrowserDrawer(user);
    await within(drawer).findByTestId('root-browser-pane');
    for (const [label, action] of [
      ['Back', 'back'],
      ['Forward', 'forward'],
    ]) {
      const button = within(drawer).getByRole('button', { name: label });
      expect(button).toBeEnabled();
      await user.click(button);
      await waitFor(() => expect(calls).toContain(`root-task:${action}`));
      await waitFor(() => expect(button).toBeEnabled());
      expect(within(drawer).getByTestId('browser-address-bar')).toHaveTextContent(`/${action}`);
    }
    expect(calls).toEqual([
      'root-task:user',
      'root-task:back',
      'root-task:user',
      'root-task:forward',
    ]);
  });

  it('keeps navigation unavailable while Root has no live browser', async () => {
    serveRoot(() => null);
    const calls = serveNavigation();
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />);
    const drawer = await openBrowserDrawer(user);
    await within(drawer).findByTestId('root-browser-empty');
    for (const label of ['Back', 'Forward', 'Reload']) {
      expect(within(drawer).getByRole('button', { name: label })).toBeDisabled();
    }
    expect(calls).toEqual([]);
  });

  it('shows a navigation failure and enables retry', async () => {
    serveRoot(() => ROOT);
    const calls = serveNavigation(409);
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />);
    const drawer = await openBrowserDrawer(user);
    await within(drawer).findByTestId('root-browser-pane');
    await user.click(within(drawer).getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t navigate');
    expect(calls).toEqual(['root-task:user', 'root-task:back']);
    expect(within(drawer).getByRole('button', { name: 'Back' })).toBeEnabled();
  });
  it('targets the selected agent task instead of the Root browser', async () => {
    serveRoot(() => ROOT);
    const calls = serveNavigation();
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <RoseAppIcons />
        {agentBrowser()}
      </>,
      { selectedAgentId: 'agent-a' },
    );
    act(() =>
      window.dispatchEvent(new CustomEvent('navi-open-browser', { detail: { taskId: 'task-1' } })),
    );
    const drawer = screen.getByTestId('browser-app-drawer');
    await user.click(within(drawer).getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(calls).toEqual(['task-1:user', 'task-1:back']));
    await waitFor(() =>
      expect(within(drawer).getByTestId('browser-address-bar')).toHaveTextContent('/back'),
    );
  });

  it('does not navigate when taking control fails', async () => {
    serveRoot(() => ROOT);
    const calls = serveNavigation();
    server.use(
      http.post(`${API}/browser-session/task/:taskId/control`, () =>
        HttpResponse.json({ error: 'Session unavailable' }, { status: 409 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />);
    const drawer = await openBrowserDrawer(user);
    await within(drawer).findByTestId('root-browser-pane');
    await user.click(within(drawer).getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t navigate');
    expect(calls).toEqual([]);
  });
});
