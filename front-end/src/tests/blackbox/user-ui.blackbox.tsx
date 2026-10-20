/**
 * Blackbox tests for the per-user UI runtime (features/user-ui).
 *
 * Covers the security + behavior contract of rose_user_ui on the app origin:
 *   - theme tokens are data: invalid names / url() / expression / ; / } rejected
 *   - background backdrop fades only after the agent's first USER message
 *   - sidebar + query box render opaque while a user background is showing
 *   - every user frame is sandbox="allow-scripts" on the usercontent origin
 *   - inline views render the version their message pins, not the active one
 *   - no more than 4 inline frames are live in a long trajectory
 *   - safe mode (query, shortcut, corner control) disables everything
 *   - the postMessage bridge ignores messages from the wrong source / origin
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import {
  InlineUserView,
  UserUiAppBackdrop,
  UserUiBackgroundLayer,
  UserUiFrame,
  UserUiProvider,
  UserUiShell,
  UserUiSlot,
  applyThemeTokens,
  resetUserUiVersionCache,
  validateThemeTokens,
  type UserUiManifest,
} from '@/features/user-ui';
import { ROSE_DESKTOP_USER_IDS } from '@/lib/roseDesktop';
import AppSidebar from '@/features/terminal-component-group/components/AppSidebar';
import Terminal from '@/pages/Terminal';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import { renderStockSidebar } from './app-sidebar.fixtures';
import { BackdropHarness } from './user-ui-backdrop-harness';

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
  theme: 'root/theme.json',
  slots: {
    background: { entry: 'root/slots/background/index.html' },
    'home.dashboard': { entry: 'root/slots/dashboard/index.html' },
  },
  inline: { chart: { entry: 'inline/chart/v2.html', summary: 'Chart v2' } },
};

function serveActive(manifest: UserUiManifest, theme: unknown = {}) {
  server.use(
    http.get(`${API_BASE}/user-ui/active`, () =>
      HttpResponse.json({ versionId: 'v2', manifest, baseUrl: ACTIVE_BASE }),
    ),
    http.get(`${ACTIVE_BASE}root/theme.json`, () => HttpResponse.json(theme)),
  );
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

describe('theme tokens', () => {
  it('accepts CSS custom properties and rejects bad names and code-like values', () => {
    const { accepted, rejected } = validateThemeTokens({
      '--rose-accent': '#7c3aed',
      '--radius': '12px',
      '--font-body': '"Inter", sans-serif',
      '--bg': 'url(https://evil.test/x.png)',
      '--bg-escaped': 'u\\72l(https://evil.test)',
      '--ie': 'expression(alert(1))',
      '--break': 'red; background: blue',
      '--close': 'red } body { color: red',
      '--Upper': 'red',
      color: 'red',
      '--number': 4,
    });
    expect(accepted).toEqual({
      '--rose-accent': '#7c3aed',
      '--radius': '12px',
      '--font-body': '"Inter", sans-serif',
    });
    expect(rejected.sort()).toEqual(
      ['--bg', '--bg-escaped', '--ie', '--break', '--close', '--Upper', 'color', '--number'].sort(),
    );
  });

  it('applies only valid tokens to <html> and removes them on cleanup', () => {
    const cleanup = applyThemeTokens({ '--rose-accent': 'tomato', '--evil': 'url(x)' });
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--rose-accent')).toBe('tomato');
    expect(style.getPropertyValue('--evil')).toBe('');
    cleanup();
    expect(style.getPropertyValue('--rose-accent')).toBe('');
  });

  it('loads theme.json for the active version and applies its validated tokens', async () => {
    serveActive(FULL_MANIFEST, { tokens: { '--rose-accent': 'rebeccapurple', '--x': 'url(a)' } });
    render(
      <UserUiProvider userId="test-user">
        <div />
      </UserUiProvider>,
    );
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--rose-accent')).toBe(
        'rebeccapurple',
      ),
    );
    expect(document.documentElement.style.getPropertyValue('--x')).toBe('');
  });

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

describe('background backdrop', () => {
  it('keeps the app backdrop opaque until the first user message, then fades it', async () => {
    serveActive(FULL_MANIFEST, {
      background: { image: 'root/assets/wallpaper.jpg', fadeAfterFirstMessage: 0.2 },
    });
    const { rerender } = render(<BackdropHarness hasUserMessage={false} />);
    const image = await screen.findByTestId('user-ui-background-image');
    expect(image).toHaveAttribute('src', `${ACTIVE_BASE}root/assets/wallpaper.jpg`);

    const backdrop = screen.getByTestId('app-background-layer');
    expect(backdrop).toHaveAttribute('data-backdrop-state', 'opaque');
    expect(backdrop.style.opacity).toBe('1');
    expect(backdrop).toHaveClass('bg-background');
    expect(backdrop.style.transition).toContain('opacity 600ms');
    expect(screen.getByTestId('pattern').parentElement).toBe(backdrop);

    rerender(<BackdropHarness hasUserMessage />);
    expect(backdrop).toHaveAttribute('data-backdrop-state', 'faded');
    expect(backdrop.style.opacity).toBe('0.2');
  });

  it('defaults the fade to 0.8 (80%) when the theme sets no fadeAfterFirstMessage', async () => {
    serveActive(FULL_MANIFEST, { background: { image: 'root/assets/wallpaper.jpg' } });
    const { rerender } = render(<BackdropHarness hasUserMessage={false} />);
    await screen.findByTestId('user-ui-background-image');
    const backdrop = screen.getByTestId('app-background-layer');
    expect(backdrop.style.opacity).toBe('1');

    rerender(<BackdropHarness hasUserMessage />);
    expect(backdrop).toHaveAttribute('data-backdrop-state', 'faded');
    expect(backdrop.style.opacity).toBe('0.8');
  });

  it('leaves the stock backdrop untouched without a background', async () => {
    serveActive({ version: 1 });
    render(<BackdropHarness hasUserMessage />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const backdrop = screen.getByTestId('app-background-layer');
    expect(backdrop).toHaveAttribute('data-backdrop-state', 'stock');
    expect(backdrop.getAttribute('style')).toBeNull();
    expect(screen.queryByTestId('user-ui-background-layer')).toBeNull();
  });
});

describe('opaque chrome over a user background', () => {
  it('renders the sidebar rail opaque only while a background shows', () => {
    const props = {
      currentView: 'agents' as const,
      onViewChange: () => {},
      agents: [],
      isLoadingAgents: false,
      selectedAgentId: null,
      onSelectAgent: () => {},
      onCreateAgent: () => {},
      onRefreshAgents: () => {},
      user: null,
      onLogout: () => {},
      onLoginClick: () => {},
    };
    const { rerender } = renderStockSidebar(<AppSidebar {...props} />);
    const rail = screen.getByRole('complementary', { hidden: true });
    expect(rail).toHaveAttribute('data-surface', 'translucent');
    expect(rail).toHaveClass('bg-white/95');

    rerender(<AppSidebar {...props} userUi={{ opaqueSurface: true }} />);
    expect(rail).toHaveAttribute('data-surface', 'opaque');
    expect(rail).toHaveClass('bg-white');
    expect(rail).not.toHaveClass('bg-white/95');
    expect(rail.style.backgroundColor).toBe('rgb(255, 255, 255)');
  });

  it('wires the terminal: background layer behind, opaque sidebar and query box', async () => {
    mockSession(ROSE_DESKTOP_USER);
    serveActive(FULL_MANIFEST, { background: { image: 'root/assets/wallpaper.jpg' } });
    renderWithProviders(<Terminal />);
    await screen.findByTestId('user-ui-background-image');
    await waitFor(() =>
      expect(screen.getByTestId('query-input-surface')).toHaveAttribute('data-surface', 'opaque'),
    );
    expect(screen.getByTestId('query-input-surface').style.backgroundColor).toBe('');
    expect(screen.getByRole('complementary', { hidden: true })).toHaveAttribute(
      'data-surface',
      'opaque',
    );
    // Landing page: no agent selected → no user message → backdrop opaque.
    expect(screen.getByTestId('app-background-layer')).toHaveAttribute(
      'data-backdrop-state',
      'opaque',
    );
    expect(
      screen
        .getByTestId('terminal-grid-background-layer')
        .closest('[data-testid="app-background-layer"]'),
    ).not.toBeNull();
    // home.dashboard slot mounts above the popular goals on the landing page.
    const dashboard = await screen.findByTestId('user-ui-slot-home.dashboard');
    expect(dashboard.querySelector('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
    // Rose Desktop chrome: bare top-right app icons, no right bar (UI ledger row 66).
    expect(screen.getByTestId('rose-app-icons')).toBeInTheDocument();
    expect(screen.queryByTestId('rose-app-bar')).toBeNull();
  });

  it('keeps the stock UI for accounts without the Rose Desktop flag, even with a published UI', async () => {
    let activeRequests = 0;
    serveActive(FULL_MANIFEST, { background: { image: 'root/assets/wallpaper.jpg' } });
    server.use(
      http.get(`${API_BASE}/user-ui/active`, () => {
        activeRequests += 1;
        return HttpResponse.json({
          versionId: 'v2',
          manifest: FULL_MANIFEST,
          baseUrl: ACTIVE_BASE,
        });
      }),
    );
    renderWithProviders(<Terminal />);
    const surface = await screen.findByTestId('query-input-surface');
    expect(surface).toHaveAttribute('data-surface', 'translucent');
    expect(screen.queryByTestId('user-ui-background-image')).toBeNull();
    expect(screen.queryByTestId('user-ui-slot-home.dashboard')).toBeNull();
    expect(screen.queryByTestId('rose-app-bar')).toBeNull();
    expect(activeRequests).toBe(0);
  });

  it('keeps the stock translucent chrome when nothing is published', async () => {
    renderWithProviders(<Terminal />);
    const surface = await screen.findByTestId('query-input-surface');
    expect(surface).toHaveAttribute('data-surface', 'translucent');
    expect(screen.queryByTestId('user-ui-background-layer')).toBeNull();
  });
});

describe('sandboxed frames', () => {
  it('mounts slots as sandbox="allow-scripts" frames on the usercontent origin', async () => {
    serveActive(FULL_MANIFEST);
    render(
      <UserUiProvider userId="test-user">
        <UserUiBackgroundLayer />
        <UserUiSlot name="home.dashboard" autoHeight />
      </UserUiProvider>,
    );
    const dashboard = await screen.findByTestId('user-ui-slot-home.dashboard');
    const frames = [
      dashboard.querySelector('iframe'),
      screen.getByTestId('user-ui-slot-background'),
    ] as HTMLIFrameElement[];
    for (const frame of frames) {
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
      expect(new URL(frame.getAttribute('src') ?? '').origin).toBe(USERCONTENT);
      expect(frame.hasAttribute('srcdoc')).toBe(false);
    }
    expect(frames[0].getAttribute('src')).toBe(`${ACTIVE_BASE}root/slots/dashboard/index.html`);
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
          manifest: FULL_MANIFEST,
          baseUrl: `${window.location.origin}/`,
        }),
      ),
    );
    render(
      <UserUiProvider userId="test-user">
        <UserUiSlot name="home.dashboard" />
      </UserUiProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(document.querySelector('iframe')).toBeNull();
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
  it('?rose_safe=1 disables theme, background, slots, shell and live inline frames', async () => {
    window.history.replaceState({}, '', '/?rose_safe=1');
    useVisibleIntersection();
    serveActive(
      { ...FULL_MANIFEST, shell: { entry: 'root/shell/index.html' } },
      { tokens: { '--rose-accent': 'red' }, background: { image: 'root/bg.jpg' } },
    );
    render(
      <UserUiProvider userId="test-user">
        <UserUiShell>
          <UserUiBackgroundLayer />
          <UserUiSlot name="home.dashboard" />
          <p>stock app</p>
          <InlineUserView inlineView={{ view: 'chart', versionId: 'v2' }} messageId="m1" />
        </UserUiShell>
      </UserUiProvider>,
    );
    expect(await screen.findByText('Chart v2')).toBeInTheDocument();
    expect(screen.getByText('stock app')).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.queryByTestId('user-ui-background-layer')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--rose-accent')).toBe('');
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
