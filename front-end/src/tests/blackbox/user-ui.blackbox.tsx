/**
 * Blackbox tests for the per-user UI runtime (features/user-ui).
 *
 * Covers the security + behavior contract of rose_user_ui on the app origin:
 *   - whole-app settings are removed (UI ledger row 89): a manifest that still
 *     names a theme, background or slots renders the stock UI — no theme.json
 *     request, no CSS tokens, no background layer or fade, no slot frames
 *   - every user frame is sandbox="allow-scripts" on the usercontent origin
 *   - inline views render the version their message pins, not the active one
 *   - no more than 4 inline frames are live in a long trajectory
 *   - safe mode (query, shortcut, corner control) disables shell + live frames
 *   - the postMessage bridge ignores messages from the wrong source / origin
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import {
  InlineUserView,
  UserUiFrame,
  UserUiProvider,
  UserUiShell,
  resetUserUiVersionCache,
  type UserUiManifest,
} from '@/features/user-ui';
import { ROSE_DESKTOP_USER_IDS } from '@/lib/roseDesktop';
import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import Terminal from '@/pages/Terminal';

import { capturedRequests } from './msw/capture';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import { renderStockSidebar } from './app-sidebar.fixtures';

const API_BASE = 'http://localhost:3001/api';
const USERCONTENT = 'https://u-test.usercontent.roselabs.test';
const ACTIVE_BASE = `${USERCONTENT}/v2/`;

/** The Rose Desktop flag (lib/roseDesktop.ts) gates the per-user UI in the real Terminal. */
const ROSE_DESKTOP_USER = ROSE_DESKTOP_USER_IDS[0];

function mockSession(userId = 'test-user') {
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: userId, is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  localStorage.setItem('app-user', JSON.stringify({ id: userId, is_anonymous: false }));
}

const FULL_MANIFEST: UserUiManifest = {
  version: 1,
  inline: { chart: { entry: 'inline/chart/v2.html', summary: 'Chart v2' } },
};

/**
 * A version published before the whole-app settings were removed: it still
 * names a theme (with tokens + a background image) and every removed slot,
 * plus fields this client has never heard of. All of it must be ignored.
 */
const LEGACY_MANIFEST = {
  ...FULL_MANIFEST,
  theme: 'root/theme.json',
  slots: {
    background: { entry: 'root/slots/background/index.html' },
    'sidebar.header': { entry: 'root/slots/header/index.html' },
    menu: { entry: 'root/slots/menu/index.html' },
    'home.dashboard': { entry: 'root/slots/dashboard/index.html' },
    'agent.panel': { entry: 'root/slots/panel/index.html' },
  },
  tools: { weather: { manifest: 'tools/weather/tool.json' } },
  futureField: { anything: true },
} as UserUiManifest;

const LEGACY_THEME = {
  tokens: { '--rose-accent': 'rebeccapurple', '--background': '0 0% 0%' },
  background: { image: 'root/assets/wallpaper.jpg', fadeAfterFirstMessage: 0.2 },
};

/** Serve the active version; returns a counter of theme.json fetches (must stay 0). */
function serveActive(manifest: UserUiManifest) {
  const themeRequests = { count: 0 };
  server.use(
    http.get(`${API_BASE}/user-ui/active`, () =>
      HttpResponse.json({ versionId: 'v2', manifest, baseUrl: ACTIVE_BASE }),
    ),
    http.get(`${ACTIVE_BASE}root/theme.json`, () => {
      themeRequests.count += 1;
      return HttpResponse.json(LEGACY_THEME);
    }),
  );
  return themeRequests;
}

/** GET /api/user-ui/active requests captured so far in this test. */
function activeRequestCount(): number {
  return capturedRequests.filter((request) => request.url.endsWith('/user-ui/active')).length;
}

/** Nothing from the removed whole-app settings reached the page. */
function expectNoWholeAppSettings(themeRequests: { count: number }) {
  expect(themeRequests.count).toBe(0);
  const rootStyle = document.documentElement.style;
  expect(rootStyle.getPropertyValue('--rose-accent')).toBe('');
  expect(rootStyle.getPropertyValue('--background')).toBe('');
  expect(document.querySelector('[data-testid^="user-ui-background"]')).toBeNull();
  expect(document.querySelector('[data-testid="app-background-layer"]')).toBeNull();
  expect(document.querySelector('[data-user-ui-slot]')).toBeNull();
  expect(document.querySelector('[data-testid^="user-ui-slot-"]')).toBeNull();
  expect(document.querySelector('img[src*="wallpaper"]')).toBeNull();
  for (const frame of document.querySelectorAll('iframe')) {
    expect(frame.getAttribute('src') ?? '').not.toContain('/root/slots/');
  }
}

/** IntersectionObserver that reports every observed element as on screen. */
class VisibleIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    queueMicrotask(() =>
      this.callback(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      ),
    );
  }
  unobserve() {}
  disconnect() {}
}

const originalIntersectionObserver = window.IntersectionObserver;

function useVisibleIntersection() {
  // setup.ts installs IntersectionObserver as a writable (non-configurable) stub.
  window.IntersectionObserver =
    VisibleIntersectionObserver as unknown as typeof window.IntersectionObserver;
}

beforeEach(() => {
  mockSession();
  sessionStorage.clear();
  resetUserUiVersionCache();
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  window.IntersectionObserver = originalIntersectionObserver;
  document.documentElement.removeAttribute('style');
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
});

describe('provider', () => {
  it('makes no request for a logged-out user', async () => {
    const seen = vi.fn();
    server.use(
      http.get(`${API_BASE}/user-ui/active`, () => {
        seen();
        return HttpResponse.json({ versionId: null });
      }),
    );
    render(
      <UserUiProvider userId={null}>
        <p>stock</p>
      </UserUiProvider>,
    );
    await screen.findByText('stock');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('removed whole-app settings (theme, background + fade, slots)', () => {
  it('ignores a legacy manifest’s theme, background and slots without errors; inline views still render', async () => {
    useVisibleIntersection();
    const errors = vi.spyOn(console, 'error');
    const warnings = vi.spyOn(console, 'warn');
    const themeRequests = serveActive(LEGACY_MANIFEST);
    render(
      <UserUiProvider userId="test-user">
        <UserUiShell>
          <p>stock app</p>
          <InlineUserView inlineView={{ view: 'chart', versionId: 'v2' }} messageId="m1" />
        </UserUiShell>
      </UserUiProvider>,
    );
    // The legacy version is active: its inline view resolves from the active manifest.
    const frame = await screen.findByTestId('user-ui-inline-frame');
    expect(frame).toHaveAttribute(
      'src',
      'http://localhost:3001/usercontent/v2/inline/chart/v2.html',
    );
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    expect(screen.getByText('stock app')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expectNoWholeAppSettings(themeRequests);
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
    // No shell published → nothing to escape, so no safe-mode control either.
    expect(screen.queryByTestId('user-ui-safe-mode-control')).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
    errors.mockRestore();
    warnings.mockRestore();
  });

  it('resolves pinned inline views from legacy /versions manifests (version history keeps working)', async () => {
    useVisibleIntersection();
    const themeRequests = serveActive(FULL_MANIFEST);
    server.use(
      http.get(`${API_BASE}/user-ui/versions`, () =>
        HttpResponse.json({
          activeVersionId: 'v2',
          versions: [
            { versionId: 'v2', manifest: FULL_MANIFEST, active: true },
            {
              versionId: 'v1',
              manifest: {
                ...LEGACY_MANIFEST,
                inline: { chart: { entry: 'inline/chart/v1.html', summary: 'Chart v1' } },
              },
              active: false,
            },
          ],
        }),
      ),
    );
    render(
      <UserUiProvider userId="test-user">
        <InlineUserView inlineView={{ view: 'chart', versionId: 'v1' }} messageId="old" />
      </UserUiProvider>,
    );
    const frame = await screen.findByTestId('user-ui-inline-frame');
    expect(frame).toHaveAttribute(
      'src',
      'http://localhost:3001/usercontent/v1/inline/chart/v1.html',
    );
    expect(frame).toHaveAttribute('title', 'Chart v1');
    expectNoWholeAppSettings(themeRequests);
  });

  it('Rose Desktop terminal: a legacy manifest leaves the stock background, sidebar and query box', async () => {
    mockSession(ROSE_DESKTOP_USER);
    const themeRequests = serveActive(LEGACY_MANIFEST);
    renderWithProviders(<Terminal />);
    const surface = await screen.findByTestId('query-input-surface');
    await waitFor(() => expect(activeRequestCount()).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Stock translucent drip surface (never the removed opaque variant).
    expect(surface).toHaveAttribute('data-surface', 'translucent');
    expect(surface).not.toHaveClass('bg-white');
    // The grid renders directly in the terminal root: no fading backdrop wrapper.
    const grid = screen.getByTestId('terminal-grid-background-layer');
    expect(grid.parentElement).toHaveClass('h-screen', 'w-screen', 'relative');
    expect(grid.parentElement?.style.opacity).toBe('');
    // Rose Desktop chrome is unchanged: solid left bar, bare top-right app icons.
    expect(screen.getByTestId('rose-sidebar')).toHaveAttribute('data-surface', 'opaque');
    expect(screen.getByTestId('rose-app-icons')).toBeInTheDocument();
    expectNoWholeAppSettings(themeRequests);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('flag off: accounts without Rose Desktop never request the user UI and keep the stock chrome', async () => {
    const themeRequests = serveActive(LEGACY_MANIFEST);
    renderWithProviders(<Terminal />);
    const surface = await screen.findByTestId('query-input-surface');
    expect(surface).toHaveAttribute('data-surface', 'translucent');
    expect(screen.queryByTestId('rose-sidebar')).toBeNull();
    expect(screen.queryByTestId('rose-app-icons')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(activeRequestCount()).toBe(0);
    expectNoWholeAppSettings(themeRequests);
  });

  it('flag off: the stock sidebar rail keeps its translucent surface', () => {
    renderStockSidebar(
      <AppSidebar
        currentView="agents"
        onViewChange={() => {}}
        agents={[]}
        isLoadingAgents={false}
        selectedAgentId={null}
        onSelectAgent={() => {}}
        onCreateAgent={() => {}}
        onRefreshAgents={() => {}}
        user={null}
        onLogout={() => {}}
        onLoginClick={() => {}}
      />,
    );
    const rail = screen.getByRole('complementary', { hidden: true });
    expect(rail).toHaveClass('bg-white/95');
    expect(rail).not.toHaveClass('bg-white');
    expect(rail.style.backgroundColor).toBe('');
  });

  it('keeps the stock translucent chrome when nothing is published', async () => {
    mockSession(ROSE_DESKTOP_USER);
    renderWithProviders(<Terminal />);
    const surface = await screen.findByTestId('query-input-surface');
    expect(surface).toHaveAttribute('data-surface', 'translucent');
    expect(screen.queryByTestId('user-ui-shell')).toBeNull();
    expect(screen.queryByTestId('user-ui-safe-mode-control')).toBeNull();
  });
});

describe('sandboxed frames', () => {
  it('mounts the shell as a sandbox="allow-scripts" frame on the usercontent origin', async () => {
    serveActive({ ...FULL_MANIFEST, shell: { entry: 'root/shell/index.html' } });
    render(
      <UserUiProvider userId="test-user">
        <UserUiShell>
          <p>stock app</p>
        </UserUiShell>
      </UserUiProvider>,
    );
    const frame = await screen.findByTestId('user-ui-shell-frame');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(new URL(frame.getAttribute('src') ?? '').origin).toBe(USERCONTENT);
    expect(frame.hasAttribute('srcdoc')).toBe(false);
    expect(frame.getAttribute('src')).toBe(`${ACTIVE_BASE}root/shell/index.html`);
  });

  it('refuses app-origin, blob:, data: and javascript: sources', () => {
    for (const src of [
      `${window.location.origin}/evil.html`,
      'blob:https://u.test/1',
      'data:text/html,<script>1</script>',
      'javascript:alert(1)',
    ]) {
      const { container, unmount } = render(<UserUiFrame src={src} title="x" />);
      expect(container.querySelector('iframe')).toBeNull();
      unmount();
    }
  });

  it('refuses an active version whose baseUrl is the app origin', async () => {
    server.use(
      http.get(`${API_BASE}/user-ui/active`, () =>
        HttpResponse.json({
          versionId: 'v2',
          manifest: { ...FULL_MANIFEST, shell: { entry: 'root/shell/index.html' } },
          baseUrl: `${window.location.origin}/`,
        }),
      ),
    );
    render(
      <UserUiProvider userId="test-user">
        <UserUiShell>
          <p>stock app</p>
        </UserUiShell>
      </UserUiProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByText('stock app')).toBeInTheDocument();
  });
});

describe('postMessage bridge', () => {
  function dispatchFromFrame(data: unknown, source: MessageEventSource | null, origin: string) {
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data, source, origin }));
    });
  }

  it('answers rose:ready with props only for the frame itself, and clamps resize', () => {
    const src = `${USERCONTENT}/v2/inline/chart/v2.html`;
    render(
      <UserUiFrame
        src={src}
        title="chart"
        props={{ points: [1, 2] }}
        onResize={() => {}}
        testId="f"
      />,
    );
    const frame = screen.getByTestId('f') as HTMLIFrameElement;
    const frameWindow = frame.contentWindow as Window;
    const post = vi.spyOn(frameWindow, 'postMessage').mockImplementation(() => {});

    dispatchFromFrame({ type: 'rose:ready' }, window, 'null');
    dispatchFromFrame({ type: 'rose:ready' }, frameWindow, 'https://evil.test');
    expect(post).not.toHaveBeenCalled();

    dispatchFromFrame({ type: 'rose:ready' }, frameWindow, 'null');
    expect(post).toHaveBeenCalledWith({ type: 'rose:props', props: { points: [1, 2] } }, '*');

    post.mockClear();
    dispatchFromFrame({ type: 'rose:ready' }, frameWindow, USERCONTENT);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('ignores resize from another window and clamps inline height to 60..900', async () => {
    useVisibleIntersection();
    serveActive(FULL_MANIFEST);
    render(
      <UserUiProvider userId="test-user">
        <InlineUserView inlineView={{ view: 'chart', versionId: 'v2' }} messageId="m1" />
      </UserUiProvider>,
    );
    const frame = (await screen.findByTestId('user-ui-inline-frame')) as HTMLIFrameElement;
    dispatchFromFrame({ type: 'rose:resize', height: 5000 }, window, 'null');
    expect(frame.style.height).toBe('240px');
    dispatchFromFrame({ type: 'rose:resize', height: 5000 }, frame.contentWindow, 'null');
    expect(frame.style.height).toBe('900px');
    dispatchFromFrame({ type: 'rose:resize', height: 3 }, frame.contentWindow, 'null');
    expect(frame.style.height).toBe('60px');
  });
});

describe('inline trajectory views', () => {
  it('renders the version the message pins, not the active version', async () => {
    useVisibleIntersection();
    serveActive(FULL_MANIFEST);
    server.use(
      http.get(`${API_BASE}/user-ui/versions`, () =>
        HttpResponse.json({
          versions: [
            { id: 'v2', manifest: FULL_MANIFEST },
            {
              id: 'v1',
              manifest: { version: 1, inline: { chart: { entry: 'inline/chart/v1.html' } } },
            },
          ],
        }),
      ),
    );
    render(
      <UserUiProvider userId="test-user">
        <InlineUserView inlineView={{ view: 'chart', versionId: 'v1' }} messageId="old" />
        <InlineUserView inlineView={{ view: 'chart', versionId: 'v2' }} messageId="new" />
      </UserUiProvider>,
    );
    await waitFor(() => expect(screen.getAllByTestId('user-ui-inline-frame')).toHaveLength(2));
    const [oldFrame, newFrame] = screen.getAllByTestId('user-ui-inline-frame');
    expect(oldFrame).toHaveAttribute(
      'src',
      'http://localhost:3001/usercontent/v1/inline/chart/v1.html',
    );
    expect(newFrame).toHaveAttribute(
      'src',
      'http://localhost:3001/usercontent/v2/inline/chart/v2.html',
    );
    for (const frame of [oldFrame, newFrame]) {
      expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    }
  });

  it('renders a view pinned to a non-active version from the real GET /versions shape (versionId)', async () => {
    useVisibleIntersection();
    serveActive(FULL_MANIFEST);
    // Mirrors back-end/src/domains/user-ui/service.ts listVersions().
    server.use(
      http.get(`${API_BASE}/user-ui/versions`, () =>
        HttpResponse.json({
          activeVersionId: 'v2',
          versions: [
            {
              versionId: 'v2',
              manifest: FULL_MANIFEST,
              fileCount: 4,
              totalBytes: 2048,
              createdAt: '2026-10-20T18:00:00.000Z',
              active: true,
            },
            {
              versionId: 'v1',
              manifest: {
                version: 1,
                inline: { chart: { entry: 'inline/chart/v1.html', summary: 'Chart v1' } },
              },
              fileCount: 2,
              totalBytes: 1024,
              createdAt: '2026-10-19T18:00:00.000Z',
              active: false,
            },
          ],
        }),
      ),
    );
    render(
      <UserUiProvider userId="test-user">
        <InlineUserView inlineView={{ view: 'chart', versionId: 'v1' }} messageId="pinned" />
      </UserUiProvider>,
    );
    const frame = await screen.findByTestId('user-ui-inline-frame');
    expect(frame).toHaveAttribute(
      'src',
      'http://localhost:3001/usercontent/v1/inline/chart/v1.html',
    );
    expect(frame).toHaveAttribute('title', 'Chart v1');
    expect(screen.getByTestId('user-ui-inline-view')).toHaveAttribute('data-inline-state', 'live');
  });

  it('keeps at most 4 frames live in a long trajectory; the rest show posters', async () => {
    useVisibleIntersection();
    serveActive({
      version: 1,
      inline: { chart: { entry: 'inline/chart/v2.html', poster: 'inline/chart/poster.png' } },
    });
    render(
      <UserUiProvider userId="test-user">
        {Array.from({ length: 40 }, (_, index) => (
          <InlineUserView
            key={index}
            inlineView={{ view: 'chart', versionId: 'v2', props: { index } }}
            messageId={`m${index}`}
          />
        ))}
      </UserUiProvider>,
    );
    await waitFor(() => expect(screen.getAllByTestId('user-ui-inline-frame')).toHaveLength(4));
    const posters = screen.getAllByTestId('user-ui-inline-poster');
    expect(posters).toHaveLength(36);
    expect(posters[0]).toHaveAttribute(
      'src',
      'http://localhost:3001/usercontent/v2/inline/chart/poster.png',
    );
    expect(document.querySelectorAll('iframe')).toHaveLength(4);
  });

  it('renders the summary while offscreen when there is no poster', async () => {
    serveActive(FULL_MANIFEST);
    render(
      <UserUiProvider userId="test-user">
        <InlineUserView inlineView={{ view: 'chart', versionId: 'v2' }} messageId="m1" />
      </UserUiProvider>,
    );
    expect(await screen.findByText('Chart v2')).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });
});

describe('safe mode', () => {
  it('?rose_safe=1 disables the shell and live inline frames', async () => {
    window.history.replaceState({}, '', '/?rose_safe=1');
    useVisibleIntersection();
    const themeRequests = serveActive({
      ...LEGACY_MANIFEST,
      shell: { entry: 'root/shell/index.html' },
    });
    render(
      <UserUiProvider userId="test-user">
        <UserUiShell>
          <p>stock app</p>
          <InlineUserView inlineView={{ view: 'chart', versionId: 'v2' }} messageId="m1" />
        </UserUiShell>
      </UserUiProvider>,
    );
    expect(await screen.findByText('Chart v2')).toBeInTheDocument();
    expect(screen.getByText('stock app')).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
    expectNoWholeAppSettings(themeRequests);
    expect(sessionStorage.getItem('rose_safe_mode')).toBe('1');
    expect(screen.getByTestId('user-ui-safe-mode-control')).toHaveTextContent('Exit safe mode');
  });

  it('a published shell replaces the chrome; the host control and shortcut escape it', async () => {
    serveActive({ version: 1, shell: { entry: 'root/shell/index.html' } });
    render(
      <UserUiProvider userId="test-user">
        <UserUiShell>
          <p>stock app</p>
        </UserUiShell>
      </UserUiProvider>,
    );
    const shell = await screen.findByTestId('user-ui-shell-frame');
    expect(shell).toHaveAttribute('sandbox', 'allow-scripts');
    expect(shell).toHaveAttribute('src', `${ACTIVE_BASE}root/shell/index.html`);
    expect(screen.queryByText('stock app')).toBeNull();

    fireEvent.click(screen.getByTestId('user-ui-safe-mode-control'));
    expect(screen.getByText('stock app')).toBeInTheDocument();
    expect(screen.queryByTestId('user-ui-shell-frame')).toBeNull();
    expect(sessionStorage.getItem('rose_safe_mode')).toBe('1');

    fireEvent.keyDown(window, { key: '>', code: 'Period', ctrlKey: true, shiftKey: true });
    expect(await screen.findByTestId('user-ui-shell-frame')).toBeInTheDocument();
    expect(sessionStorage.getItem('rose_safe_mode')).toBeNull();

    fireEvent.keyDown(window, { key: '.', code: 'Period', metaKey: true, shiftKey: true });
    expect(screen.getByText('stock app')).toBeInTheDocument();
  });

  it('persists for the tab: a later mount stays in safe mode without the query', async () => {
    sessionStorage.setItem('rose_safe_mode', '1');
    serveActive({ version: 1, shell: { entry: 'root/shell/index.html' } });
    render(
      <UserUiProvider userId="test-user">
        <UserUiShell>
          <p>stock app</p>
        </UserUiShell>
      </UserUiProvider>,
    );
    expect(await screen.findByText('Exit safe mode')).toBeInTheDocument();
    expect(screen.getByText('stock app')).toBeInTheDocument();
  });
});
