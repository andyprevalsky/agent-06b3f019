import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveInitialTerminalView } from '@/features/terminal/hooks/resolveInitialTerminalView';
import { useQuickQuery, type QuickQueryDeps } from '@/features/terminal/hooks/useQuickQuery';
import { openAgentInCurrentClient } from '@/lib/openAgent';

function makeDeps(): QuickQueryDeps {
  return {
    selectedModel: 'rose-1-lite',
    canSubmitGoals: true,
    clientSource: 'MAC_APP',
    pendingPriceLimitCents: 500,
    setCurrentView: vi.fn(),
    setMessageInput: vi.fn(),
    setIsSendingMessage: vi.fn(),
    setIsLoadingNetwork: vi.fn(),
    setLoginModalOpen: vi.fn(),
    setSelectedAgentIdContext: vi.fn(),
    loadAgents: vi.fn(async () => undefined),
    toast: vi.fn() as QuickQueryDeps['toast'],
  };
}

describe('desktop open-agent navigation', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('routes to the terminal, selects the task, and clears stale browser context', () => {
    window.history.replaceState({}, '', '/?agent-id=old-agent&browser-id=stale-browser#/browse');

    openAgentInCurrentClient('agent-from-web');

    const url = new URL(window.location.href);
    expect(url.searchParams.get('agent-id')).toBe('agent-from-web');
    expect(url.searchParams.get('browser-id')).toBeNull();
    expect(url.hash).toBe('#/');
  });

  it('switches an internal terminal view back to the agent chat', () => {
    const deps = makeDeps();
    const { unmount } = renderHook(() => useQuickQuery(deps));

    act(() => openAgentInCurrentClient('agent-from-web'));

    expect(deps.setCurrentView).toHaveBeenCalledWith('agents');
    unmount();
  });

  it('agent deep-link URL overrides the browser-review initial view', () => {
    localStorage.setItem('app-user', JSON.stringify({ phone: '+15555550123' }));
    window.history.replaceState({}, '', '/?agent-id=agent-from-web#/');

    expect(resolveInitialTerminalView()).toBe('agents');
  });
});
