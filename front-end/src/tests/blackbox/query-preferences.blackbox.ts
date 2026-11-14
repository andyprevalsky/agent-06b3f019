import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  resetQueryPreferencesMemory,
  readQueryPreferences,
  writeQueryPreferences,
} from '@/lib/queryPreferences';
import { useQueryPreference } from '@/hooks/useQueryPreference';
import {
  useMessageSending,
  type UseMessageSendingArgs,
} from '@/features/terminal/hooks/useMessageSending';
import { defaultModelForAccount } from '@/features/terminal/hooks/useTerminalAgents';
import { ADMIN_USER_IDS } from '@/lib/adminAccounts';

const account = 'query-defaults-test';
afterEach(() => {
  localStorage.clear();
  resetQueryPreferencesMemory();
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.trim().split('=')[0]!;
    if (name.startsWith('rose-query-defaults%3A')) document.cookie = `${name}=;Max-Age=0;Path=/`;
  }
  vi.restoreAllMocks();
});

it('restores model, budget and exact speed from cookies after device storage loss', () => {
  writeQueryPreferences(account, {
    model: 'rose-labs/rose-local',
    priceLimitCents: 1234,
    fastMode: false,
    ultraPreferred: false,
  });
  localStorage.clear();
  resetQueryPreferencesMemory();
  expect(readQueryPreferences(account)).toEqual({
    model: 'rose-labs/rose-local',
    priceLimitCents: 1234,
    fastMode: false,
    ultraPreferred: false,
  });
  expect(readQueryPreferences('different-account')).toEqual({});
});

it('rejects malformed values and excludes drafts and credential fields', () => {
  localStorage.setItem(
    `rose-query-defaults:${account}`,
    JSON.stringify({
      model: '',
      priceLimitCents: -5,
      fastMode: 'yes',
      ultraPreferred: 1,
      draft: 'secret',
      token: 'secret',
    }),
  );
  expect(readQueryPreferences(account)).toEqual({});
  writeQueryPreferences(account, { priceLimitCents: 1 });
  expect(readQueryPreferences(account)).toEqual({ priceLimitCents: 1 });
});

it('keeps account changes isolated and restores each preference without stale state', () => {
  const hook = renderHook(({ id }) => useQueryPreference(id, 'priceLimitCents', 200), {
    initialProps: { id: account },
  });
  act(() => hook.result.current[1](901));
  hook.rerender({ id: 'different-account' });
  expect(hook.result.current[0]).toBe(200);
  act(() => hook.result.current[1](502));
  hook.rerender({ id: account });
  expect(hook.result.current[0]).toBe(901);
  hook.unmount();
  const restored = renderHook(() => useQueryPreference(account, 'priceLimitCents', 200));
  expect(restored.result.current[0]).toBe(901);
});

it('keeps controls usable when persistence is blocked', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('blocked');
  });
  vi.spyOn(document, 'cookie', 'set').mockImplementation(() => {
    throw Error('blocked');
  });
  const hook = renderHook(() => useQueryPreference(account, 'priceLimitCents', 200));
  act(() => hook.result.current[1](500));
  expect(hook.result.current[0]).toBe(500);
});

function args(): UseMessageSendingArgs {
  return {
    userId: ADMIN_USER_IDS[0]!,
    user: { id: ADMIN_USER_IDS[0]! },
    selectedAgentId: null,
    agentDetail: null,
    canSubmitGoals: true,
    isFullySignedIn: true,
    clientSource: 'WEB',
    setCurrentView: vi.fn(),
    setLoginModalOpen: vi.fn(),
    setIsLoadingNetwork: vi.fn(),
    loadAgents: vi.fn(async () => {}),
    stagePendingAgentCreation: vi.fn(),
    reconcilePendingAgentCreation: vi.fn(async () => {}),
    rollbackPendingAgentCreation: vi.fn(() => true),
    stageUserMessage: vi.fn(() => ({ confirm: vi.fn(), drop: vi.fn() })),
  };
}

it('remembers explicit composer choices while loading an agent never rewrites the defaults', () => {
  const input = args();
  const hook = renderHook(() => useMessageSending(input));
  act(() => {
    hook.result.current.setSelectedModel('rose-labs/rose-local');
    hook.result.current.setPendingPriceLimitCents(1750);
    hook.result.current.setFastMode(false);
  });
  act(() => hook.result.current.syncSelectedModel('an-existing-agent-model'));
  expect(
    defaultModelForAccount({ user: input.user!, isFullySignedIn: true, isAnonymous: false }),
  ).toBe('rose-labs/rose-local');
  hook.unmount();
  const restored = renderHook(() => useMessageSending(args()));
  expect(restored.result.current.selectedModel).toBe('rose-labs/rose-local');
  expect(restored.result.current.pendingPriceLimitCents).toBe(1750);
  expect(restored.result.current.fastMode).toBe(false);
});
