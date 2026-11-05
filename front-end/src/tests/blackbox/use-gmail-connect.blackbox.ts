import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  disconnectGmailAccountApi,
  fetchIntegrationsApi,
  startGmailOAuthApi,
} from '@/features/integrations/api';
import { useGmailConnect } from '@/features/integrations/hooks/useGmailConnect';

vi.mock('@/features/integrations/api', () => ({
  disconnectGmailAccountApi: vi.fn(),
  fetchIntegrationsApi: vi.fn(),
  startGmailOAuthApi: vi.fn(),
}));

describe('useGmailConnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(startGmailOAuthApi).mockResolvedValue({ authUrl: 'https://gmail.test/oauth' });
    vi.mocked(fetchIntegrationsApi).mockResolvedValue([]);
    vi.mocked(disconnectGmailAccountApi).mockResolvedValue();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { openExternal: vi.fn().mockResolvedValue({ success: true }) },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(window, 'api');
    vi.clearAllMocks();
  });

  it('cancels OAuth polling and its timeout on unmount', async () => {
    const fetchIntegrations = vi.fn().mockResolvedValue(undefined);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { result, unmount } = renderHook(() => useGmailConnect(fetchIntegrations));

    await act(async () => result.current.handleEmailConnect('gmail'));
    const callsAtUnmount = vi.mocked(fetchIntegrationsApi).mock.calls.length;
    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchIntegrationsApi).toHaveBeenCalledTimes(callsAtUnmount);
  });

  it('desktop: returns via the app deep link and refreshes integrations when it lands', async () => {
    let deliver: ((data: { success: boolean }) => void) | undefined;
    const dispose = vi.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        openExternal: vi.fn().mockResolvedValue({ success: true }),
        onOAuthComplete: vi.fn((cb: (data: { success: boolean }) => void) => {
          deliver = cb;
          return dispose;
        }),
      },
    });
    const fetchIntegrations = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useGmailConnect(fetchIntegrations));

    await act(async () => result.current.handleEmailConnect('gmail'));
    expect(startGmailOAuthApi).toHaveBeenCalledWith('roselabs://oauth-complete');
    expect(result.current.connectingProvider).toBe('gmail');

    await act(async () => deliver?.({ success: true }));
    expect(fetchIntegrations).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalled();
    expect(result.current.connectingProvider).toBeNull();
  });

  it('first desktop connect: the unstamped pre-consent row and a failed fetch never settle', async () => {
    const fetchIntegrations = vi.fn().mockResolvedValue(undefined);
    // Nothing connected before consent.
    vi.mocked(fetchIntegrationsApi).mockResolvedValue([]);
    const { result } = renderHook(() => useGmailConnect(fetchIntegrations));
    await act(async () => result.current.handleEmailConnect('gmail'));

    // The OAuth start's unstamped row appears: still no callback evidence.
    vi.mocked(fetchIntegrationsApi).mockResolvedValue([
      { id: 'i1', name: 'gmail', status: 'SYNCING', isActive: false },
    ]);
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    // A failed poll (fetchIntegrationsApi yields []) also reads as no evidence.
    vi.mocked(fetchIntegrationsApi).mockResolvedValue([]);
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(fetchIntegrations).not.toHaveBeenCalled();
    expect(result.current.connectingProvider).toBe('gmail');

    // The callback stamps the row: now it settles.
    vi.mocked(fetchIntegrationsApi).mockResolvedValue([
      {
        id: 'i1',
        name: 'gmail',
        status: 'CONNECTED',
        isActive: true,
        lastSuccessfulSyncAt: '2026-11-05T01:00:00.000Z',
        config: { connectedEmails: ['a@example.com'] },
      },
    ]);
    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    expect(fetchIntegrations).toHaveBeenCalledTimes(1);
    expect(result.current.connectingProvider).toBeNull();
  });

  it('reconnect: a failed poll after an existing stamp does not settle', async () => {
    const stamped = {
      id: 'i1',
      name: 'gmail',
      status: 'CONNECTED' as const,
      isActive: true,
      lastSuccessfulSyncAt: '2026-11-01T00:00:00.000Z',
      config: { connectedEmails: ['a@example.com'] },
    };
    vi.mocked(fetchIntegrationsApi).mockResolvedValue([stamped]);
    const fetchIntegrations = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useGmailConnect(fetchIntegrations));
    await act(async () => result.current.handleEmailConnect('gmail'));

    vi.mocked(fetchIntegrationsApi).mockResolvedValue([]);
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(fetchIntegrations).not.toHaveBeenCalled();
    expect(result.current.connectingProvider).toBe('gmail');
  });

  it('desktop poll waits for the callback to land, not for the pre-created row', async () => {
    const row = (stamp?: string) => ({
      id: 'i1',
      name: 'gmail',
      status: 'SYNCING' as const,
      isActive: false,
      lastSuccessfulSyncAt: stamp,
    });
    // The OAuth start upserts the gmail row BEFORE consent, so it already exists.
    vi.mocked(fetchIntegrationsApi).mockResolvedValue([row()]);
    const fetchIntegrations = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useGmailConnect(fetchIntegrations));

    await act(async () => result.current.handleEmailConnect('gmail'));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetchIntegrations).not.toHaveBeenCalled();
    expect(result.current.connectingProvider).toBe('gmail');

    vi.mocked(fetchIntegrationsApi).mockResolvedValue([row('2026-10-28T06:00:00.000Z')]);
    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    expect(fetchIntegrations).toHaveBeenCalledTimes(1);
    expect(result.current.connectingProvider).toBeNull();
  });
});
