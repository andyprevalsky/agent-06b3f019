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
    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchIntegrationsApi).not.toHaveBeenCalled();
  });
});
