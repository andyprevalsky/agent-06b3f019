/** Actual PhoneApp private attention form uses authenticated exact request/agent/task/lease. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, renderHook, fireEvent, screen, waitFor } from '@testing-library/react';
import { snapshot } from '@amplitude/rrweb-snapshot';
import { createPrivacyRecorderOptions } from '@amplitude/session-replay-dom-privacy';
import { BrowserStatusBarFullscreen } from '@/features/terminal-component-group/components/browser-status-bar/BrowserStatusBarFullscreen';
import { AgentContext } from '@/features/terminal-component-group/hooks';
import { RoseAppsContext } from '@/features/terminal-component-group/components/rose-apps/roseAppsState';
import { PhoneAppScreen } from '@/features/terminal-component-group/components/rose-apps/PhoneAppScreen';
import type { AgentContextValue } from '@/features/agent-context/types';
import type { RoseAppsValue } from '@/features/terminal-component-group/components/rose-apps/roseAppsState';
import { usePhoneAttention } from '@/features/terminal-component-group/components/browser-status-bar/phone/usePhoneAttention';
import { phoneAttentionCandidate } from '@/features/terminal-component-group/components/browser-status-bar/phone/phoneAttentionState';
import { phoneAppTarget } from '@/features/terminal-component-group/components/rose-apps/phoneAppTarget';
import { fixture, messages, target, meta, props } from './fixtures/phone-attention.fixture';
vi.mock(
  '@/features/terminal-component-group/components/browser-status-bar/BrowserTaskProgressPanel',
  () => ({ TaskProgressSidebar: () => <div>Task progress</div> }),
);
vi.mock('@/lib/api/client', () => ({
  API_BASE_WITH_PATH: 'http://localhost:3001/api',
  getAuthHeaders: () => ({ Authorization: 'Bearer synthetic-user' }),
}));
function view(currentMessages = messages) {
  return (
    <RoseAppsContext.Provider
      value={{ selectedAgentId: 'agent-a', tabs: [] } as unknown as RoseAppsValue}
    >
      <AgentContext.Provider
        value={
          {
            agent: { agent_id: 'agent-a' },
            selectedAgentId: 'agent-a',
            messages: currentMessages,
            isLoadingAgent: false,
            inspectionContext: null,
          } as unknown as AgentContextValue
        }
      >
        <PhoneAppScreen />
      </AgentContext.Provider>
    </RoseAppsContext.Provider>
  );
}
beforeEach(() => {
  window.history.replaceState({}, '', '/');
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:phone');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('masks and clears exact private input, dispatches once, never stores it in replay or storage', async () => {
  const f = fixture();
  const v = render(view());
  const input = await screen.findByLabelText('Private phone password');
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: 'SYNTHETIC-PRIVATE-CANARY' } });
  expect(JSON.stringify(snapshot(document, createPrivacyRecorderOptions()))).not.toContain(
    'SYNTHETIC-PRIVATE-CANARY',
  );
  const submit = screen.getByRole('button', { name: 'Type privately' });
  fireEvent.click(submit);
  fireEvent.click(submit);
  await waitFor(() => expect(f.posts.filter((p) => p.operation === 'input.text')).toHaveLength(1));
  expect(input).toHaveValue('');
  expect(JSON.stringify(localStorage)).not.toContain('SYNTHETIC-PRIVATE-CANARY');
  expect(JSON.stringify(sessionStorage)).not.toContain('SYNTHETIC-PRIVATE-CANARY');
  v.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalled();
});
it.each([
  { agentId: 'foreign' },
  { target: { ...target, leaseId: 'foreign' } },
  { completedAt: '2026-10-18T22:00:00Z' },
])('rejects mismatched authoritative attention %j', async (other) => {
  const f = fixture(other);
  render(view());
  await waitFor(() =>
    expect(f.calls.some((c) => c.endsWith('/auth-assistance/request-a'))).toBe(true),
  );
  expect(screen.queryByLabelText('Private phone password')).toBeNull();
  expect(f.posts).toEqual([]);
});
it('blocks completion and all new private input after an unknown command receipt', async () => {
  window.history.replaceState(
    {},
    '',
    '/?agent-id=agent-a&browser-id=task-a&attention-request-id=request-a',
  );
  const f = fixture();
  f.setUnknown(true);
  render(view());
  const input = await screen.findByLabelText('Private phone password');
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: 'PRIVATE-UNCERTAIN-CANARY' } });
  fireEvent.click(screen.getByRole('button', { name: 'Type privately' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Authentication complete/ })).toBeDisabled(),
  );
  expect(input).toHaveValue('');
  expect(f.posts.filter((p) => p.operation === 'input.text')).toHaveLength(1);
  expect(new URL(window.location.href).searchParams.get('attention-request-id')).toBe('request-a');
});

it.each(['modern', 'compat'] as const)(
  'preserves completion and wakes later same-task activity in %s after release',
  async (surface) => {
    const f = fixture();
    const original = vi.mocked(fetch).getMockImplementation()!;
    let released = false;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (String(url).endsWith('/interactions/task-a') && released) {
        const value = await response.json();
        return new Response(
          JSON.stringify({ ...value, lease: { ...value.lease, status: 'RELEASED' } }),
        );
      }
      return response;
    });
    window.history.replaceState(
      {},
      '',
      '/?agent-id=agent-a&browser-id=task-a&attention-request-id=request-a',
    );
    const renderSurface = (currentMessages = messages) =>
      surface === 'modern' ? (
        view(currentMessages)
      ) : (
        <BrowserStatusBarFullscreen {...props()} messages={currentMessages} />
      );
    const mounted = render(renderSurface());
    const complete = await screen.findByRole('button', { name: 'Authentication complete' });
    await waitFor(() => expect(complete).toBeEnabled());
    fireEvent.click(complete);
    await waitFor(() =>
      expect(screen.getByText('Authentication complete. Agent will verify sign-in.')).toBeVisible(),
    );
    released = true;
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Cloud iPhone' })).toBeNull(), {
      timeout: 3500,
    });
    const reads = f.calls.filter((call) => call.endsWith('/interactions/task-a')).length;
    released = false;
    mounted.rerender(
      renderSurface([
        {
          ...messages[0],
          message_id: 'later-phone',
          metadata: { task_id: 'task-a', toolName: 'phone', action_type: 'phone' },
        },
      ]),
    );
    await waitFor(
      () =>
        expect(
          f.calls.filter((call) => call.endsWith('/interactions/task-a')).length,
        ).toBeGreaterThan(reads),
      { timeout: 2000 },
    );
    expect(await screen.findByRole('region', { name: 'Cloud iPhone' })).toBeVisible();
    expect(
      f.calls.filter((call) => call.startsWith('POST') && call.endsWith('/complete')),
    ).toHaveLength(1);
  },
);

it('retires only an acknowledged exact locator while keeping completion visible and old metadata dormant', async () => {
  const f = fixture({ completedAt: '2026-11-06T00:00:00Z' });
  window.history.replaceState(
    {},
    '',
    '/?agent-id=agent-a&browser-id=task-a&attention-request-id=request-a&keep=1',
  );
  const mounted = render(view([]));
  await waitFor(() =>
    expect(screen.getByText('Authentication complete. Agent will verify sign-in.')).toBeVisible(),
  );
  await waitFor(() =>
    expect(new URL(window.location.href).searchParams.has('attention-request-id')).toBe(false),
  );
  expect(new URL(window.location.href).searchParams.get('keep')).toBe('1');
  const reads = f.calls.filter((call) => call.endsWith('/auth-assistance/request-a')).length;
  mounted.rerender(view(messages));
  expect(screen.getByText('Authentication complete. Agent will verify sign-in.')).toBeVisible();
  expect(f.calls.filter((call) => call.endsWith('/auth-assistance/request-a'))).toHaveLength(reads);
  expect(screen.queryByTestId('phone-private-authentication')).toBeNull();
  expect(f.posts).toEqual([]);
});
it('does not reuse completed-task fallback when newer phone activity is ambiguous', async () => {
  const f = fixture({ completedAt: '2026-11-06T00:00:00Z' });
  const mounted = render(view());
  await waitFor(() =>
    expect(screen.getByText('Authentication complete. Agent will verify sign-in.')).toBeVisible(),
  );
  const calls = f.calls.length;
  mounted.rerender(
    view(
      ['task-b', 'task-c'].map((task) => ({
        ...messages[0],
        message_id: task,
        metadata: { task_id: task, toolName: 'phone' },
      })),
    ),
  );
  expect(screen.getByText('No active phone interaction for this agent.')).toBeVisible();
  expect(screen.queryByTestId('phone-private-authentication')).toBeNull();
  expect(f.calls).toHaveLength(calls);
});
it('rejects a foreign-scope locator even when its ID equals the retired request', () => {
  const f = fixture();
  window.history.replaceState(
    {},
    '',
    '/?agent-id=foreign-agent&browser-id=foreign-task&attention-request-id=request-a',
  );
  expect(phoneAttentionCandidate('task-a', 'agent-a', messages, 'request-a')).toBe('');
  expect(
    phoneAppTarget('agent-a', messages, [], { taskId: 'task-a', requestId: 'request-a' }),
  ).toBeNull();
  render(view());
  expect(screen.queryByTestId('phone-private-authentication')).toBeNull();
  expect(f.calls).toEqual([]);
});
it('allows a distinct new exact request after retiring the completed one', async () => {
  const f = fixture({ completedAt: '2026-11-06T00:00:00Z' });
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((url, init) =>
    String(url).endsWith('/auth-assistance/request-b')
      ? Promise.resolve(
          new Response(
            JSON.stringify({
              request: {
                id: 'request-b',
                agentId: 'agent-a',
                mode: 'manual_step',
                target,
                criticalReason: 'password',
                completedAt: null,
              },
            }),
          ),
        )
      : original(url, init),
  );
  const hook = renderHook(
    ({ currentMessages }) => usePhoneAttention('task-a', 'agent-a', currentMessages, false),
    { initialProps: { currentMessages: messages } },
  );
  await waitFor(() => expect(hook.result.current.request?.completedAt).toBeTruthy());
  expect(hook.result.current.id).toBe('');
  hook.rerender({
    currentMessages: [
      {
        ...messages[0],
        metadata: {
          ...messages[0].metadata,
          requestUserAuthentication: {
            ...meta,
            requestId: 'request-b',
          },
        },
      },
    ],
  });
  await waitFor(() => expect(hook.result.current.request?.id).toBe('request-b'));
  expect(hook.result.current.id).toBe('request-b');
  expect(f.posts).toEqual([]);
});
