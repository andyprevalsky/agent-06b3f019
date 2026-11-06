/**
 * Blackbox tests for `main/app/deepLinks.ts` — the custom-protocol
 * (`roselabs://…`) deep-link plumbing that wires Stripe payment redirects back
 * into the renderer.
 *
 * Observable surface exercised here (nothing else imports this module in the
 * test graph, so it was previously only ~72% branch-covered by accident):
 *
 *   - registerDeepLinkProtocol(protocol):
 *       * dev-mode branch (process.defaultApp === true AND argv.length >= 2):
 *         registers with execPath + resolved argv[1] so `npm run` launches keep
 *         the protocol bound to the dev binary.
 *       * packaged branch (defaultApp false / too-few argv): registers the bare
 *         protocol.
 *   - registerOpenUrlHandler + handleDeepLink:
 *       * `open-url` events call preventDefault() and route by URL host.
 *       * host=open             -> delegates activation with an optional agent ID.
 *       * host=payment-success  -> shows/focuses the window + sends
 *         payment-complete { success: true }.
 *       * host=payment-cancel   -> sends payment-complete { success: false }.
 *       * host=oauth-complete   -> focuses + sends oauth-complete { success } from
 *         the backend's `oauth_result` param (Gmail callback back into the app).
 *       * unknown host          -> no send (no-op).
 *       * malformed URL         -> swallowed (no throw, no send).
 *       * getMainWindow() null OR window.isDestroyed() -> no focus/send (guard).
 *
 * The electron `app` is mocked; we assert on the exact args passed to
 * `app.setAsDefaultProtocolClient` and `webContents.send`, which are the real
 * contracts between us and electron / the renderer. No network involved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted electron mock ────────────────────────────────────────────────────
const appState = vi.hoisted(() => ({
  setAsDefaultProtocolClient: vi.fn(),
  openUrlListeners: [] as Array<(event: unknown, url: string) => void>,
}));

vi.mock('electron', () => ({
  app: {
    setAsDefaultProtocolClient: appState.setAsDefaultProtocolClient,
    on: vi.fn((channel: string, cb: (event: unknown, url: string) => void) => {
      if (channel === 'open-url') appState.openUrlListeners.push(cb);
    }),
  },
}));

import {
  handleDeepLink,
  registerDeepLinkProtocol,
  registerOpenUrlHandler,
} from '../../main/app/deepLinks';

// ── Fake BrowserWindow ───────────────────────────────────────────────────────
interface FakeWindow {
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  webContents: { send: ReturnType<typeof vi.fn> };
}

function makeWindow(destroyed = false): FakeWindow {
  return {
    show: vi.fn(),
    focus: vi.fn(),
    isDestroyed: vi.fn(() => destroyed),
    webContents: { send: vi.fn() },
  };
}

// Snapshot the real process flags so we can mutate + restore per test.
const realDefaultApp = process.defaultApp;
const realArgv = process.argv;

beforeEach(() => {
  appState.setAsDefaultProtocolClient.mockClear();
  appState.openUrlListeners.length = 0;
});

afterEach(() => {
  Object.defineProperty(process, 'defaultApp', {
    configurable: true,
    value: realDefaultApp,
  });
  process.argv = realArgv;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// registerDeepLinkProtocol — the dev vs packaged branch
// ---------------------------------------------------------------------------

describe('deepLinks — registerDeepLinkProtocol', () => {
  it('dev mode (defaultApp + argv >= 2): registers with execPath and resolved argv[1]', () => {
    Object.defineProperty(process, 'defaultApp', { configurable: true, value: true });
    process.argv = ['node', 'main.js', 'extra'];

    registerDeepLinkProtocol('roselabs');

    expect(appState.setAsDefaultProtocolClient).toHaveBeenCalledTimes(1);
    const call = appState.setAsDefaultProtocolClient.mock.calls[0];
    expect(call[0]).toBe('roselabs');
    expect(call[1]).toBe(process.execPath);
    // argv[1] is resolved to an absolute path.
    expect(call[2]).toEqual([expect.stringContaining('main.js')]);
  });

  it('packaged mode (defaultApp false): registers the bare protocol only', () => {
    Object.defineProperty(process, 'defaultApp', { configurable: true, value: false });
    process.argv = ['/Applications/Rose.app/Contents/MacOS/Rose'];

    registerDeepLinkProtocol('roselabs');

    expect(appState.setAsDefaultProtocolClient).toHaveBeenCalledTimes(1);
    expect(appState.setAsDefaultProtocolClient).toHaveBeenCalledWith('roselabs');
  });

  it('defaultApp true but argv too short: still takes the bare-protocol branch', () => {
    Object.defineProperty(process, 'defaultApp', { configurable: true, value: true });
    process.argv = ['node']; // length 1 -> condition false

    registerDeepLinkProtocol('roselabs');

    expect(appState.setAsDefaultProtocolClient).toHaveBeenCalledWith('roselabs');
  });
});

// ---------------------------------------------------------------------------
// handleDeepLink — host routing + guards
// ---------------------------------------------------------------------------

describe('deepLinks — handleDeepLink', () => {
  it('open: delegates activation with the requested agent ID', () => {
    const win = makeWindow();
    const openApp = vi.fn();
    handleDeepLink('roselabs://open?agent-id=agent-123', () => win as never, openApp);

    expect(openApp).toHaveBeenCalledWith('agent-123');
    expect(win.show).not.toHaveBeenCalled();
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('payment-success: focuses the window and sends payment-complete { success: true }', () => {
    const win = makeWindow();
    handleDeepLink('roselabs://payment-success', () => win as never, vi.fn());

    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledWith('payment-complete', { success: true });
  });

  it('payment-cancel: sends payment-complete { success: false }', () => {
    const win = makeWindow();
    handleDeepLink('roselabs://payment-cancel', () => win as never, vi.fn());

    expect(win.webContents.send).toHaveBeenCalledWith('payment-complete', { success: false });
  });

  it('oauth-complete: focuses the app and forwards the OAuth result', () => {
    const win = makeWindow();
    handleDeepLink(
      'roselabs://oauth-complete?oauth_result=success&message=Connected',
      () => win as never,
      vi.fn()
    );
    expect(win.show).toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith('oauth-complete', { success: true });

    const failed = makeWindow();
    handleDeepLink('roselabs://oauth-complete?oauth_result=error', () => failed as never, vi.fn());
    expect(failed.webContents.send).toHaveBeenCalledWith('oauth-complete', { success: false });
  });

  it('unknown host: does not focus or send anything', () => {
    const win = makeWindow();
    handleDeepLink('roselabs://something-else', () => win as never, vi.fn());

    expect(win.show).not.toHaveBeenCalled();
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('malformed URL: swallows the parse error without throwing or sending', () => {
    const win = makeWindow();
    expect(() => handleDeepLink('not a url', () => win as never, vi.fn())).not.toThrow();
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('guard: null main window -> no focus/send', () => {
    // getMainWindow returns null: forwardPaymentComplete must bail before send.
    expect(() => handleDeepLink('roselabs://payment-success', () => null, vi.fn())).not.toThrow();
  });

  it('guard: destroyed window -> no focus/send', () => {
    const win = makeWindow(true);
    handleDeepLink('roselabs://payment-success', () => win as never, vi.fn());

    expect(win.show).not.toHaveBeenCalled();
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// registerOpenUrlHandler — event wiring
// ---------------------------------------------------------------------------

describe('deepLinks — registerOpenUrlHandler', () => {
  it('calls preventDefault and routes the open-url event through handleDeepLink', () => {
    const win = makeWindow();
    registerOpenUrlHandler(() => win as never, vi.fn());

    expect(appState.openUrlListeners).toHaveLength(1);

    const preventDefault = vi.fn();
    appState.openUrlListeners[0]({ preventDefault }, 'roselabs://payment-success');

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledWith('payment-complete', { success: true });
  });
});
