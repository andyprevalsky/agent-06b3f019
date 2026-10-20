/**
 * Blackbox: the Rose Desktop left-bar Apps section (UI ledger row 10).
 *
 *   GET /api/user-ui/apps → one row per app below the project groups: Rose first
 *   (dev accounts only; the Rose mark), then published apps (icon_url or a
 *   neutral glyph), then "+ New app". Collapsed: the project-group line pill.
 *   Refetched exactly once per USER_UI_ACTIVE_CHANGED for a version not already
 *   listed; never polled. 403 ROSE_DEV_ONLY renders nothing, not an error.
 *   Flag off: no request and no section.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import { UserAppsProvider } from '@/features/terminal-component-group/components/user-apps/UserAppsProvider';
import { notifyUserUiActiveChanged } from '@/lib/openAgentActivity';

import { defaultProps, makeAgent, mockSession } from './app-sidebar.fixtures';
import { clearCaptures } from './msw/capture';
import { server } from './msw/server';
import { collapseBar, expandBar, signedInUser } from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';
import {
  API_BASE,
  ROSE_APP,
  appsBody,
  renderTerminal,
  requests,
  serveApps,
  serveTerminalBasics,
  signInStock,
  userApp,
} from './user-apps.fixtures';

function renderBar(userId: string | null = 'test-user', overrides = {}) {
  const props = defaultProps({
    agents: [makeAgent({ agent_id: 'a-home', goal: 'Plan Tahoe trip', project_id: null })],
    user: signedInUser(),
    ...overrides,
  });
  renderWithProviders(
    <UserAppsProvider userId={userId}>
      <AppSidebar {...props} />
    </UserAppsProvider>,
  );
  return props;
}

function appRowIds(): string[] {
  return within(screen.getByTestId('rose-apps-section'))
    .queryAllByTestId(/^rose-app-row-/)
    .map((row) => row.getAttribute('data-testid') ?? '');
}

beforeEach(() => {
  localStorage.clear();
  mockSession();
  clearCaptures();
});

afterEach(() => localStorage.clear());

describe('Apps section rows', () => {
  it('lists Rose first, then the published apps, then + New app, below the project groups', async () => {
    serveApps(
      appsBody([ROSE_APP, userApp(), userApp({ id: 'notes', title: 'Notes', icon_url: null })]),
    );
    renderBar();
    expandBar();
    const section = await screen.findByTestId('rose-apps-section');
    expect(appRowIds()).toEqual(['rose-app-row-rose', 'rose-app-row-game', 'rose-app-row-notes']);
    expect(within(section).getByTestId('rose-apps-divider')).toHaveTextContent('Apps');
    // Rose mark (inline svg), the app's own icon, and a neutral glyph without one.
    expect(within(screen.getByTestId('rose-app-row-rose')).getByText('Rose')).toBeInTheDocument();
    expect(screen.getByTestId('rose-app-row-rose').querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('rose-app-row-game').querySelector('img')).toHaveAttribute(
      'src',
      'https://uc.rose.test/usercontent/v2/apps/game/icon.png',
    );
    expect(screen.getByTestId('rose-app-row-notes').querySelector('img')).toBeNull();
    expect(screen.getByTestId('rose-app-row-notes').querySelector('svg')).not.toBeNull();
    expect(within(section).getByRole('button', { name: '+ New app' })).toBeInTheDocument();
    // The section sits after the agent groups (and their "+ New project").
    const groups = screen.getByTestId('rose-agent-groups');
    expect(groups.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No wrappers: rows are bare buttons, none marked selected yet.
    for (const id of appRowIds()) {
      expect(screen.getByTestId(id)).toHaveAttribute('data-selected', 'false');
      expect(screen.getByTestId(id).className).not.toMatch(/\bbg-|ring-|rounded-full/);
    }
  });

  it('collapsed: the project-group line pill, app icons only, no + New app', async () => {
    serveApps(appsBody([ROSE_APP, userApp()]));
    renderBar();
    expandBar();
    await screen.findByTestId('rose-app-row-rose');
    collapseBar();
    const section = screen.getByTestId('rose-apps-section');
    expect(within(section).getByTestId('rose-group-divider')).toBeInTheDocument();
    expect(within(section).queryByTestId('rose-apps-divider')).not.toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: '+ New app' })).not.toBeInTheDocument();
    expect(appRowIds()).toEqual(['rose-app-row-rose', 'rose-app-row-game']);
  });

  it('+ New app calls roseActions.onNewApp (never creates an agent itself)', async () => {
    serveApps(appsBody([ROSE_APP]));
    const onNewApp = vi.fn();
    const props = renderBar('test-user', { roseActions: { onNewApp } });
    expandBar();
    fireEvent.click(await screen.findByRole('button', { name: '+ New app' }));
    expect(onNewApp).toHaveBeenCalledTimes(1);
    expect(props.onCreateAgent).not.toHaveBeenCalled();
    expect(requests('POST', '/agents')).toHaveLength(0);
  });
});

describe('Apps list refresh (no polling)', () => {
  it('refetches once per USER_UI_ACTIVE_CHANGED for a new version, not for the listed one', async () => {
    const api = serveApps(
      appsBody([ROSE_APP, userApp()], 'v2'),
      appsBody(
        [ROSE_APP, userApp(), userApp({ id: 'notes', title: 'Notes', version_id: 'v3' })],
        'v3',
      ),
    );
    renderBar();
    expandBar();
    await screen.findByTestId('rose-app-row-game');
    expect(api.calls()).toBe(1);

    act(() => notifyUserUiActiveChanged('agent-1', 'v2'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.calls()).toBe(1);

    act(() => notifyUserUiActiveChanged('agent-1', 'v3'));
    expect(await screen.findByTestId('rose-app-row-notes')).toBeInTheDocument();
    expect(api.calls()).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(api.calls()).toBe(2);
  });

  it('other open-agent activity (messages, status) never refetches the Apps list', async () => {
    const api = serveApps(appsBody([ROSE_APP]));
    renderBar();
    await screen.findByTestId('rose-apps-section');
    const { notifyOpenAgentActivity } = await import('@/lib/openAgentActivity');
    act(() => notifyOpenAgentActivity({ agentId: 'agent-1', kind: 'message' }));
    act(() => notifyOpenAgentActivity({ agentId: 'agent-1', kind: 'status' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.calls()).toBe(1);
  });
});

describe('Dev-only Rose and controls', () => {
  it('a non-dev list (no Rose) shows only the published apps', async () => {
    serveApps(appsBody([userApp()]));
    renderBar();
    expandBar();
    await screen.findByTestId('rose-app-row-game');
    expect(screen.queryByTestId('rose-app-row-rose')).not.toBeInTheDocument();
  });

  it('403 ROSE_DEV_ONLY renders nothing at all (no section, no error)', async () => {
    server.use(
      http.get(`${API_BASE}/user-ui/apps`, () =>
        HttpResponse.json(
          { error: 'Rose-in-Rose is limited to Rose dev accounts', code: 'ROSE_DEV_ONLY' },
          { status: 403 },
        ),
      ),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderBar();
    expandBar();
    await waitFor(() => expect(requests('GET', '/user-ui/apps')).toHaveLength(1));
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(screen.queryByTestId('rose-apps-section')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/ROSE_DEV_ONLY|limited to Rose dev/)).not.toBeInTheDocument();
    warn.mockRestore();
  });

  it('no signed-in Rose Desktop user (userId null): no request, no section', async () => {
    renderBar(null);
    expandBar();
    await screen.findByTestId('rose-agent-groups');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests('GET', '/user-ui/apps')).toHaveLength(0);
    expect(screen.queryByTestId('rose-apps-section')).not.toBeInTheDocument();
  });

  it('flag off (stock account in the real Terminal): no Apps request and no section', async () => {
    signInStock();
    serveTerminalBasics();
    renderTerminal();
    await screen.findByPlaceholderText('Enter any goal');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByTestId('rose-sidebar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rose-apps-section')).not.toBeInTheDocument();
    expect(requests('GET', '/user-ui/apps')).toHaveLength(0);
  });
});
