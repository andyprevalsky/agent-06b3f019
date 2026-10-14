/**
 * Blackbox tests for useBrowserSync hook.
 *
 * The hook coordinates browser cookie sync flows, exposing the Atlas password
 * modal state and a sync callback that defers to the IPC handlers.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useBrowserSync } from '@/features/integrations/hooks/useBrowserSync';

import type { BrowserInfo, IntegrationHandlers } from '@/features/integration-handlers-context';

function makeHandlers(overrides: Partial<IntegrationHandlers> = {}) {
  const base = {
    browserCookies: {
      isAvailable: true,
      getInstalledBrowsers: vi.fn(async (): Promise<BrowserInfo[]> => [
        { type: 'chrome', name: 'Chrome', isInstalled: true, needsManualPassword: false },
        { type: 'atlas', name: 'Atlas', isInstalled: true, needsManualPassword: true },
      ]),
      syncBrowser: vi.fn(async () => {}),
      syncBrowserPasswords: vi.fn(async () => ({ success: true })),
      storeAtlasPassword: vi.fn(async () => ({ success: true })),
      openKeychainAccess: vi.fn(async () => ({ success: true })),
    },
  };
  return { ...base, ...overrides };
}

describe('useBrowserSync', () => {
  it('fetches installed browsers on mount when browserCookies is available', async () => {
    const handlers = makeHandlers();
    const fetchIntegrations = vi.fn(async () => {});
    const { result } = renderHook(() => useBrowserSync(handlers, fetchIntegrations));
    await waitFor(() => {
      expect(result.current.installedBrowsers.length).toBe(2);
    });
    expect(handlers.browserCookies.getInstalledBrowsers).toHaveBeenCalled();
  });

  it('skips fetch when browserCookies handler is unavailable', async () => {
    const handlers = { browserCookies: { isAvailable: false } } as never;
    const fetchIntegrations = vi.fn();
    const { result } = renderHook(() => useBrowserSync(handlers, fetchIntegrations));
    await waitFor(() => {
      expect(result.current.installedBrowsers).toEqual([]);
    });
  });

  it('logs an error when getInstalledBrowsers rejects', async () => {
    const handlers = makeHandlers({
      browserCookies: {
        isAvailable: true,
        getInstalledBrowsers: vi.fn(async () => {
          throw new Error('nope');
        }),
        syncBrowser: vi.fn(),
        syncBrowserPasswords: vi.fn(),
        storeAtlasPassword: vi.fn(),
        openKeychainAccess: vi.fn(),
      },
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderHook(() => useBrowserSync(handlers, vi.fn()));
    await waitFor(() => {
      expect(errSpy).toHaveBeenCalled();
    });
    errSpy.mockRestore();
  });

  it('handleBrowserSync calls syncBrowser and refetches integrations on normal browser', async () => {
    const handlers = makeHandlers();
    const fetchIntegrations = vi.fn(async () => {});
    const { result } = renderHook(() => useBrowserSync(handlers, fetchIntegrations));
    await waitFor(() => expect(result.current.installedBrowsers.length).toBe(2));

    await act(async () => {
      await result.current.handleBrowserSync('chrome');
    });
    expect(handlers.browserCookies.syncBrowser).toHaveBeenCalledWith('chrome');
    expect(fetchIntegrations).toHaveBeenCalled();
    expect(result.current.browserSyncLoading).toBeNull();
  });

  it('handleBrowserSync no-ops when browserType is not installed', async () => {
    const handlers = makeHandlers();
    const fetchIntegrations = vi.fn();
    const { result } = renderHook(() => useBrowserSync(handlers, fetchIntegrations));
    await waitFor(() => expect(result.current.installedBrowsers.length).toBe(2));
    await act(async () => {
      await result.current.handleBrowserSync('edge' as never);
    });
    expect(handlers.browserCookies.syncBrowser).not.toHaveBeenCalled();
  });

  it('handleBrowserSync opens the Atlas modal when needsManualPassword is true', async () => {
    const handlers = makeHandlers();
    const fetchIntegrations = vi.fn();
    const { result } = renderHook(() => useBrowserSync(handlers, fetchIntegrations));
    await waitFor(() => expect(result.current.installedBrowsers.length).toBe(2));

    await act(async () => {
      await result.current.handleBrowserSync('atlas');
    });
    expect(result.current.atlasModalOpen).toBe(true);
    expect(handlers.browserCookies.syncBrowser).not.toHaveBeenCalled();
  });

  it('handleAtlasSync syncs with password, stores it, closes modal, and refetches', async () => {
    const handlers = makeHandlers();
    const fetchIntegrations = vi.fn(async () => {});
    const { result } = renderHook(() => useBrowserSync(handlers, fetchIntegrations));
    await waitFor(() => expect(result.current.installedBrowsers.length).toBe(2));

    // Open the modal first via a needsManualPassword browser
    await act(async () => {
      await result.current.handleBrowserSync('atlas');
    });
    expect(result.current.atlasModalOpen).toBe(true);

    await act(async () => {
      await result.current.handleAtlasSync('hunter2');
    });
    expect(handlers.browserCookies.syncBrowser).toHaveBeenCalledWith('atlas', 'hunter2');
    expect(handlers.browserCookies.storeAtlasPassword).toHaveBeenCalledWith('hunter2');
    expect(result.current.atlasModalOpen).toBe(false);
    expect(fetchIntegrations).toHaveBeenCalled();
  });

  it('handleAtlasSync no-ops when no pending browser', async () => {
    const handlers = makeHandlers();
    const fetchIntegrations = vi.fn();
    const { result } = renderHook(() => useBrowserSync(handlers, fetchIntegrations));
    await waitFor(() => expect(result.current.installedBrowsers.length).toBe(2));

    await act(async () => {
      await result.current.handleAtlasSync('pw');
    });
    expect(handlers.browserCookies.syncBrowser).not.toHaveBeenCalled();
    expect(handlers.browserCookies.storeAtlasPassword).not.toHaveBeenCalled();
  });

  it('handleOpenKeychain delegates to the handler with the Atlas keyword', async () => {
    const handlers = makeHandlers();
    const { result } = renderHook(() => useBrowserSync(handlers, vi.fn()));
    await act(async () => {
      await result.current.handleOpenKeychain();
    });
    expect(handlers.browserCookies.openKeychainAccess).toHaveBeenCalledWith('ChatGPT Safe Storage');
  });

  it('handleOpenKeychain no-ops when no browserCookies handler', async () => {
    const handlers = { browserCookies: undefined } as never;
    const { result } = renderHook(() => useBrowserSync(handlers, vi.fn()));
    // should not throw
    await act(async () => {
      await result.current.handleOpenKeychain();
    });
  });

  it('closeAtlasModal resets modal + pending browser state', async () => {
    const handlers = makeHandlers();
    const { result } = renderHook(() => useBrowserSync(handlers, vi.fn()));
    await waitFor(() => expect(result.current.installedBrowsers.length).toBe(2));
    await act(async () => {
      await result.current.handleBrowserSync('atlas');
    });
    expect(result.current.atlasModalOpen).toBe(true);

    act(() => {
      result.current.closeAtlasModal();
    });
    expect(result.current.atlasModalOpen).toBe(false);
  });

  it('clears loading on sync failure', async () => {
    const handlers = makeHandlers({
      browserCookies: {
        isAvailable: true,
        getInstalledBrowsers: vi.fn(async (): Promise<BrowserInfo[]> => [
          { type: 'chrome', name: 'Chrome', isInstalled: true, needsManualPassword: false },
        ]),
        syncBrowser: vi.fn(async () => {
          throw new Error('sync failed');
        }),
        syncBrowserPasswords: vi.fn(),
        storeAtlasPassword: vi.fn(),
        openKeychainAccess: vi.fn(),
      },
    });
    const { result } = renderHook(() => useBrowserSync(handlers, vi.fn()));
    await waitFor(() => expect(result.current.installedBrowsers.length).toBe(1));
    await act(async () => {
      await expect(result.current.handleBrowserSync('chrome')).rejects.toThrow('sync failed');
    });
    expect(result.current.browserSyncLoading).toBeNull();
  });
});
