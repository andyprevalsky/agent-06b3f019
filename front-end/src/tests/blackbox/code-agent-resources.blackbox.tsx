/**
 * Blackbox (item 29): a code agent's sandbox CPU / memory / disk on its chip
 * and in its code-agent view header.
 *
 *   CODE_RESOURCES {agentId, taskId, resources} on agent:<id>   (real subscribeToAgent
 *     handler over a stubbed Supabase channel)
 *     └─ lib/codeResources store ─► CodeResourcesIndicator (three bars + popover)
 *
 * Asserts the popover lines in the reference format ("36% of 8 cores",
 * "11 / 16 GiB 69%", "4.9 GiB available on this box", "93 / 103 GiB 91%",
 * "9.6 GiB free on workspace disk", "Updated <local h:mm:ss AM/PM>"), the amber
 * bar from 80%, "Unavailable" for an unmeasured resource, no indicator before
 * a sample or once the session ended, and no request on hover.
 */
import { createElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';

import { CodeAgentConversationView } from '@/features/terminal-component-group/components/code-agent-view/CodeAgentConversationView';
import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';
import { clearCodeResources, publishCodeResources } from '@/lib/codeResources';
import { supabase } from '@/lib/supabase';

import { WithAgent, chipMessage, renderChip, signIn } from './code-agent-steering.fixtures';
import { renderWithProviders } from './test-wrapper';

const { fetchSession } = vi.hoisted(() => ({ fetchSession: vi.fn().mockResolvedValue(null) }));
vi.mock('@/features/terminal-component-group/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/terminal-component-group/api')>()),
  fetchCodeAgentSession: fetchSession,
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    write() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

const GIB = 1024 ** 3;
const SAMPLED_AT = '2026-10-26T18:02:15.000Z';
const SAMPLE = {
  sampled_at: SAMPLED_AT,
  cpu: { used_pct: 36.4, cores: 8 },
  memory: { used_bytes: 11.1 * GIB, total_bytes: 16 * GIB },
  disk: { used_bytes: 93.4 * GIB, total_bytes: 103 * GIB },
};

let deliver: (record: unknown) => void = () => {};

beforeAll(async () => {
  // The real subscribeToAgent CODE_RESOURCES handler (parse + validate) feeds the
  // store; useRealtimeSubscription's own onCodeResources → publishCodeResources
  // link is covered in hooks-lib-realtime-subscription.blackbox.ts.
  const events: Record<string, (wrapper: unknown) => void> = {};
  const channel = { on: vi.fn(), subscribe: vi.fn() };
  channel.on.mockImplementation(
    (_type: string, cfg: { event: string }, handler: (wrapper: unknown) => void) => {
      events[cfg.event] = handler;
      return channel;
    },
  );
  channel.subscribe.mockImplementation((cb: (status: string) => void) => {
    cb('SUBSCRIBED');
    return channel;
  });
  vi.spyOn(supabase, 'channel').mockReturnValue(channel as never);
  vi.spyOn(supabase, 'removeChannel').mockReturnValue('ok' as never);
  vi.spyOn(supabase.realtime, 'setAuth').mockResolvedValue(undefined as never);
  signIn();
  const realtime = await vi.importActual<typeof import('@/lib/realtime')>('@/lib/realtime');
  await realtime.subscribeToAgent('agent-001', {
    onCodeResources: ({ taskId, resources }) => publishCodeResources(taskId, resources),
  });
  deliver = (record) => act(() => events['CODE_RESOURCES']?.({ payload: { record } }));
});

beforeEach(() => {
  resetCodeAgentLocalState();
  clearCodeResources();
  fetchSession.mockClear();
  signIn();
});

afterEach(() => {
  vi.useRealTimers();
});

function localTime(iso: string): string {
  const at = new Date(iso);
  const hours = at.getHours();
  const mm = String(at.getMinutes()).padStart(2, '0');
  const ss = String(at.getSeconds()).padStart(2, '0');
  return `${hours % 12 || 12}:${mm}:${ss} ${hours < 12 ? 'AM' : 'PM'}`;
}

function text(element: HTMLElement): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function sample(overrides: Record<string, unknown> = {}) {
  return { agentId: 'agent-001', taskId: 'task-1', resources: { ...SAMPLE, ...overrides } };
}

function bars(scope: HTMLElement) {
  return ['cpu', 'memory', 'disk'].map((key) => {
    const bar = within(scope).getByTestId(`code-resources-bar-${key}`);
    return [key, bar.dataset.pct, bar.dataset.warning];
  });
}

function openPopover(scope: HTMLElement): HTMLElement {
  fireEvent.pointerEnter(within(scope).getByTestId('code-resources'), { pointerType: 'mouse' });
  return screen.getByTestId('code-resources-popover');
}

function expectReferenceLines(popover: HTMLElement) {
  const line = (id: string) => text(within(popover).getByTestId(id));
  expect(line('code-resources-cpu-value')).toBe('36% of 8 cores');
  expect(within(popover).queryByTestId('code-resources-cpu-sub')).toBeNull();
  expect(line('code-resources-memory-value')).toBe('11 / 16 GiB 69%');
  expect(line('code-resources-memory-sub')).toBe('4.9 GiB available on this box');
  expect(line('code-resources-disk-value')).toBe('93 / 103 GiB 91%');
  expect(line('code-resources-disk-sub')).toBe('9.6 GiB free on workspace disk');
  expect(line('code-resources-updated')).toBe(`Updated ${localTime(SAMPLED_AT)}`);
}

describe('code-agent sandbox resources', () => {
  it('chip: no indicator before a sample; bars and the popover lines from the channel sample', () => {
    renderChip([chipMessage({ state: 'live' })]);
    const chip = screen.getByTestId('code-agent-chip');
    expect(within(chip).queryByTestId('code-resources')).toBeNull();

    deliver(sample());
    expect(bars(chip)).toEqual([
      ['cpu', '36', 'false'],
      ['memory', '69', 'false'],
      ['disk', '91', 'true'],
    ]);
    const requests = fetchSession.mock.calls.length;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expectReferenceLines(openPopover(chip));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fetchSession.mock.calls.length).toBe(requests);
    fetchSpy.mockRestore();
  });

  it('an older sample never replaces a newer one; a malformed event is dropped', () => {
    renderChip([chipMessage({ state: 'live' })]);
    deliver(sample());
    deliver(sample({ sampled_at: '2026-10-26T18:00:00.000Z', cpu: { used_pct: 99, cores: 8 } }));
    deliver({ agentId: 'agent-001', taskId: 'task-1', resources: { sampled_at: 'never' } });
    expect(bars(screen.getByTestId('code-agent-chip'))[0]).toEqual(['cpu', '36', 'false']);
  });

  it('an unmeasured resource reads Unavailable with an empty bar, never zero', () => {
    renderChip([chipMessage({ state: 'live' })]);
    deliver(sample({ disk: null }));
    const chip = screen.getByTestId('code-agent-chip');
    expect(bars(chip)[2]).toEqual(['disk', '', 'false']);
    const popover = openPopover(chip);
    expect(text(within(popover).getByTestId('code-resources-disk-value'))).toBe('Unavailable');
    expect(within(popover).queryByTestId('code-resources-disk-sub')).toBeNull();
    expect(text(within(popover).getByTestId('code-resources-memory-value'))).toBe(
      '11 / 16 GiB 69%',
    );
  });

  it('a finished or paused session shows no indicator', () => {
    deliver(sample());
    for (const state of ['completed', 'paused']) {
      const { unmount } = renderChip([chipMessage({ state, ended_at: SAMPLED_AT })]);
      expect(screen.getByTestId('code-agent-chip').dataset.codeAgentState).toBe(state);
      expect(screen.queryByTestId('code-resources')).toBeNull();
      unmount();
    }
  });

  it('code-agent view top strip: the same bars and popover lines', () => {
    deliver(sample());
    renderWithProviders(
      createElement(
        WithAgent,
        { messages: [chipMessage({ state: 'live' })] },
        createElement(CodeAgentConversationView, {
          codeAgent: {
            taskId: 'task-1',
            ownerAgentId: 'agent-001',
            provider: 'codex',
            title: '3-state speed button',
            status: 'ACTIVE',
          },
          readOnlyMessage: 'read only',
        }),
      ),
      { roseDesktop: true },
    );
    // The view has no header: the devbox usage sits in its top-right strip.
    const header = screen.getByTestId('code-agent-view');
    expect(bars(header)).toEqual([
      ['cpu', '36', 'false'],
      ['memory', '69', 'false'],
      ['disk', '91', 'true'],
    ]);
    expectReferenceLines(openPopover(header));
  });
});
