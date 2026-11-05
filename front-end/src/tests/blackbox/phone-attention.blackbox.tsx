/** Native attention must resolve an exact authenticated target before private user input. */
import { afterEach, beforeEach, expect, it, vi, describe } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  renderHook,
  within,
} from '@testing-library/react';
import { snapshot } from '@amplitude/rrweb-snapshot';
import { createPrivacyRecorderOptions } from '@amplitude/session-replay-dom-privacy';
import { BrowserStatusBarFullscreen } from '@/features/terminal-component-group/components/browser-status-bar/BrowserStatusBarFullscreen';
import { RequestListItem } from '@/features/terminal-component-group/components/attention-inbox/RequestListItem';
import { useAttentionKeyboardShortcuts } from '@/features/terminal-component-group/components/attention-inbox/useAttentionKeyboardShortcuts';
import { usePhoneAttention } from '@/features/terminal-component-group/components/browser-status-bar/phone/usePhoneAttention';
import type { Message } from '@/features/terminal-component-group/hooks';

vi.mock('@/lib/api/client', () => ({
  API_BASE_WITH_PATH: 'http://localhost:3001/api',
  getAuthHeaders: () => ({
    Authorization: 'Bearer synthetic-user',
    'Content-Type': 'application/json',
  }),
}));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/features/terminal-component-group/components/BrowserBorderGlow', () => ({
  default: () => null,
}));
vi.mock('@/features/terminal-component-group/components/BrowserCursorOverlay', () => ({
  default: () => null,
}));
vi.mock(
  '@/features/terminal-component-group/components/browser-status-bar/BrowserTaskProgressPanel',
  () => ({ TaskProgressSidebar: () => <div>Task progress</div> }),
);
vi.mock(
  '@/features/terminal-component-group/components/browser-status-bar/BrowserProxyLocationChip',
  () => ({ BrowserProxyLocationChip: () => null }),
);
import { target, meta, messages, props, fixture } from './fixtures/phone-attention.fixture';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:private-phone');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

it('opens native attention without liveViewUrl, masks input, binds one private intent and clears it immediately', async () => {
  const f = fixture();
  const view = render(<BrowserStatusBarFullscreen {...props()} />);
  const browser = screen.getByTitle('Browser');
  const input = await screen.findByLabelText('Private phone password');
  await waitFor(() => expect(input).toBeEnabled());
  expect(input).toHaveAttribute('type', 'password');
  expect(input.closest('[data-amp-block]')).toBe(
    screen.getByRole('region', { name: 'Cloud iPhone' }),
  );
  expect(screen.queryByRole('button', { name: 'Type' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Hand back phone control' })).toBeNull();
  const secret = 'UNREGISTERED-PRIVATE-INPUT-6b';
  fireEvent.change(input, { target: { value: secret } });
  expect(JSON.stringify(snapshot(document, createPrivacyRecorderOptions()))).not.toContain(secret);
  const submit = screen.getByRole('button', { name: 'Type privately' });
  fireEvent.click(submit);
  fireEvent.click(submit);
  expect(input).toHaveValue('');
  await waitFor(() => expect(f.posts.filter((p) => p.operation === 'input.text')).toHaveLength(1));
  expect(f.posts.find((p) => p.operation === 'input.text')).toMatchObject({
    attentionRequestId: 'request-a',
    args: { s: secret },
  });
  expect(JSON.stringify(snapshot(document, createPrivacyRecorderOptions()))).not.toContain(secret);
  expect(JSON.stringify(localStorage)).not.toContain(secret);
  expect(JSON.stringify(sessionStorage)).not.toContain(secret);
  expect(screen.getByTitle('Browser')).toBe(browser);
  expect(f.calls.some((c) => /refresh-session|resume|respond/.test(c))).toBe(false);
  view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalled();
});

it.each([
  { agentId: 'another-agent' },
  { target: { ...target, leaseId: 'another-lease' } },
  { completedAt: '2026-10-18T22:00:00Z' },
])('rejects stale or mismatched authoritative attention %j', async (overrides) => {
  const f = fixture(overrides);
  render(<BrowserStatusBarFullscreen {...props()} />);
  await waitFor(() =>
    expect(f.calls.some((c) => c.endsWith('/auth-assistance/request-a'))).toBe(true),
  );
  expect(screen.queryByLabelText('Private phone password')).toBeNull();
  await waitFor(() =>
    expect(screen.getByRole('status', { name: 'Phone authentication status' })).toBeInTheDocument(),
  );
  expect(f.posts).toEqual([]);
});

it('keeps an inspected request read-only without even a bounds mutation', async () => {
  const f = fixture();
  render(<BrowserStatusBarFullscreen {...props()} readOnly />);
  expect(await screen.findByText('Read-only phone view')).toBeInTheDocument();
  expect(screen.queryByLabelText('Private phone password')).toBeNull();
  expect(f.posts).toEqual([]);
});

it('never replays uncertain private input and disables completion while its stable receipt is unknown', async () => {
  const f = fixture();
  f.setUnknown(true);
  const view = render(<BrowserStatusBarFullscreen {...props()} />);
  const input = await screen.findByLabelText('Private phone password');
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: 'PRIVATE-UNCERTAIN-CANARY' } });
  fireEvent.click(screen.getByRole('button', { name: 'Type privately' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Authentication complete' })).toBeDisabled(),
  );
  expect(input).toHaveValue('');
  await waitFor(() => expect(f.calls.some((c) => c.includes('/operations/'))).toBe(true));
  const original = f.posts.find((p) => p.operation === 'input.text');
  view.unmount();
  render(<BrowserStatusBarFullscreen {...props()} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Authentication complete' })).toBeDisabled(),
  );
  expect(f.posts.filter((p) => p.operation === 'input.text')).toEqual([original]);
});

it('recovers a lost exact completion response by read, with no secret body or second completion POST', async () => {
  const f = fixture();
  f.setCompleteLost();
  const parent = props();
  render(<BrowserStatusBarFullscreen {...parent} />);
  const browser = screen.getByTitle('Browser');
  browser.setAttribute('data-qa-retained', 'same-frame');
  const complete = await screen.findByRole('button', { name: 'Authentication complete' });
  await waitFor(() => expect(complete).toBeEnabled());
  fireEvent.click(complete);
  fireEvent.click(complete);
  expect(await screen.findByText(/Agent will verify/)).toBeInTheDocument();
  expect(f.calls.filter((c) => c.startsWith('POST') && c.endsWith('/complete'))).toHaveLength(1);
  expect(parent.onResume).not.toHaveBeenCalled();
  expect(screen.getByTitle('Browser')).toBe(browser);
  expect(browser).toHaveAttribute('data-qa-retained', 'same-frame');
});

it('routes an exact native inbox request without a live URL and prevents generic keyboard completion', async () => {
  const request = {
    id: 'request-a',
    agent_id: 'agent-a',
    workflow_id: 'wf',
    question: 'Private verification',
    created_at: '2026-10-18',
    updated_at: '2026-10-18',
    answered: false,
    metadata: {
      attentionKind: 'auth_assistance',
      authAssistance: { ...meta, mode: 'manual_step' },
    },
  };
  const respond = vi.fn(),
    select = vi.fn();
  renderHook(() =>
    useAttentionKeyboardShortcuts({
      isOpen: true,
      requests: [request],
      onRespond: respond,
      onSkip: vi.fn(),
    }),
  );
  render(
    <RequestListItem
      request={request}
      remainingCount={0}
      responseText=""
      loading={false}
      actionRequestId={null}
      onSelectAgent={select}
      onClose={vi.fn()}
      onChangeResponse={vi.fn()}
      onAccept={respond}
      onSkip={vi.fn()}
      onReject={vi.fn()}
      onSendViaIMessage={vi.fn()}
    />,
  );
  fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
  expect(respond).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open phone' }));
  const url = new URL(window.location.href);
  expect(url.searchParams.get('attention-request-id')).toBe('request-a');
  expect(url.searchParams.get('browser-id')).toBe('task-a');
  expect(select).toHaveBeenCalledWith('agent-a');
});

it('resolves an exact notification request without relying on transcript metadata', async () => {
  fixture();
  window.history.replaceState(
    {},
    '',
    '/?agent-id=agent-a&browser-id=task-a&attention-request-id=request-a',
  );
  render(<BrowserStatusBarFullscreen {...props()} messages={[]} />);
  expect(await screen.findByLabelText('Private phone password')).toBeInTheDocument();
});

it('clears an undispatched secret on hide and inspection change without releasing or completing attention', async () => {
  const f = fixture();
  const parent = props();
  const view = render(<BrowserStatusBarFullscreen {...parent} />);
  const input = await screen.findByLabelText('Private phone password');
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: 'PRIVATE-HIDDEN-CANARY' } });
  const visibility = vi.spyOn(document, 'visibilityState', 'get');
  visibility.mockReturnValue('hidden');
  fireEvent(document, new Event('visibilitychange'));
  await waitFor(() => expect(screen.queryByLabelText('Private phone password')).toBeNull());
  visibility.mockReturnValue('visible');
  fireEvent(document, new Event('visibilitychange'));
  expect(await screen.findByLabelText('Private phone password')).toHaveValue('');
  view.rerender(<BrowserStatusBarFullscreen {...parent} readOnly />);
  expect(screen.queryByLabelText('Private phone password')).toBeNull();
  expect(f.calls.some((c) => /\/(release|control|complete)$/.test(c))).toBe(false);
  expect(f.posts.filter((p) => p.operation === 'input.text')).toEqual([]);
});

it('uses a manual verification target without a password form and never claims setup readiness', async () => {
  fixture({ criticalReason: 'manual_verification' });
  render(<BrowserStatusBarFullscreen {...props()} />);
  expect(await screen.findByText('Complete verification on the phone.')).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).toBeNull();
  const complete = screen.getByRole('button', { name: 'Authentication complete' });
  await waitFor(() => expect(complete).toBeEnabled());
  fireEvent.click(complete);
  expect(await screen.findByText(/Agent will verify/)).toBeInTheDocument();
  expect(screen.queryByText(/setup ready|iCloud ready/i)).toBeNull();
});

it('cannot act on a different agent through an exact notification locator', async () => {
  const f = fixture();
  window.history.replaceState(
    {},
    '',
    '/?agent-id=another-agent&browser-id=task-a&attention-request-id=request-a',
  );
  render(<BrowserStatusBarFullscreen {...props()} messages={[]} />);
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(screen.queryByLabelText('Private phone password')).toBeNull();
  expect(f.posts).toEqual([]);
  expect(f.calls).toEqual([]);
});

it('rejects a stale completion callback after the selected agent changes', async () => {
  const f = fixture();
  const hook = renderHook(({ agentId }) => usePhoneAttention('task-a', agentId, messages, false), {
    initialProps: { agentId: 'agent-a' },
  });
  await waitFor(() => expect(hook.result.current.request?.id).toBe('request-a'));
  const oldComplete = hook.result.current.complete;
  hook.rerender({ agentId: 'agent-b' });
  await waitFor(() => expect(hook.result.current.error).not.toBe(''));
  await act(async () => {
    await oldComplete();
  });
  expect(f.calls.filter((c) => c.startsWith('POST') && c.endsWith('/complete'))).toEqual([]);
});

it('fences all phone input immediately while completion is in flight', async () => {
  const f = fixture();
  const original = vi.mocked(fetch).getMockImplementation();
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/complete'))
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    return original(url, init);
  });
  const view = render(<BrowserStatusBarFullscreen {...props()} />);
  const complete = await screen.findByRole('button', { name: 'Authentication complete' });
  await waitFor(() => expect(complete).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Private phone password'), {
    target: { value: 'PRIVATE-UNSENT-COMPLETE' },
  });
  fireEvent.click(complete);
  expect(screen.getByRole('button', { name: 'Tap cloud iPhone screen' })).toBeDisabled();
  expect(screen.getByLabelText('Private phone password')).toHaveValue('');
  expect(f.posts.filter((p) => p.operation === 'input.text')).toEqual([]);
  view.unmount();
});

it.each([401, 403, 409])(
  'handles a known completion rejection %s without automatic retry',
  async (status) => {
    const f = fixture();
    const original = vi.mocked(fetch).getMockImplementation();
    let attempts = 0;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/complete')) {
        attempts++;
        return new Response(JSON.stringify({ error: 'PRIVATE-REJECTION-DETAIL' }), { status });
      }
      return original(url, init);
    });
    const hook = renderHook(() => usePhoneAttention('task-a', 'agent-a', messages, false));
    await waitFor(() => expect(hook.result.current.request?.id).toBe('request-a'));
    await act(async () => {
      await hook.result.current.complete();
    });
    await waitFor(() => expect(hook.result.current.completing).toBe(false));
    expect(JSON.stringify(hook.result.current)).not.toContain('PRIVATE-REJECTION-DETAIL');
    expect(attempts).toBe(1);
    expect(f.posts).toEqual([]);
    await act(async () => {
      await hook.result.current.complete();
    });
    expect(attempts).toBe(2);
  },
);

it('reports a mismatched linked task instead of opening another browser task', async () => {
  const { PhoneAppScreen } =
    await import('@/features/terminal-component-group/components/rose-apps/PhoneAppScreen');
  const { RoseAppsContext } =
    await import('@/features/terminal-component-group/components/rose-apps/roseAppsState');
  const { AgentContext } = await import('@/features/terminal-component-group/hooks');
  const f = fixture();
  window.history.replaceState(
    {},
    '',
    '/?agent-id=agent-a&browser-id=missing-task&attention-request-id=request-a',
  );
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((url, init) =>
    String(url).endsWith('/interactions/missing-task')
      ? Promise.resolve(
          new Response(
            JSON.stringify({ lease: null, cursor: 0, lastOperation: null, pendingOperation: null }),
          ),
        )
      : original(url, init),
  );
  render(
    <RoseAppsContext.Provider
      value={
        {
          selectedAgentId: 'agent-a',
          tabs: [],
        } as unknown as import('@/features/terminal-component-group/components/rose-apps/roseAppsState').RoseAppsValue
      }
    >
      <AgentContext.Provider
        value={
          {
            agent: { agent_id: 'agent-a' },
            selectedAgentId: 'agent-a',
            messages: [],
            isLoadingAgent: false,
            inspectionContext: null,
          } as unknown as import('@/features/agent-context/types').AgentContextValue
        }
      >
        <PhoneAppScreen />
      </AgentContext.Provider>
    </RoseAppsContext.Provider>,
  );
  expect(
    await screen.findByRole('status', { name: 'Phone authentication status' }),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole('status', { name: 'Phone authentication status' })).toHaveTextContent(
      /stale|match/i,
    ),
  );
  expect(screen.queryByTitle('Browser')).toBeNull();
  expect(screen.queryByTestId('phone-private-authentication')).toBeNull();
  expect(f.posts).toEqual([]);
  expect(f.calls.some((call) => call.includes('/leases/'))).toBe(false);
});

it.each(['transport', 'server'])(
  'keeps an uncertain %s completion status-only until the exact request is acknowledged',
  async (failure) => {
    const f = fixture(),
      original = vi.mocked(fetch).getMockImplementation();
    let attempts = 0;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/complete')) {
        attempts++;
        if (failure === 'transport') throw new TypeError('synthetic loss');
        return new Response('', { status: 500 });
      }
      return original(url, init);
    });
    const hook = renderHook(() => usePhoneAttention('task-a', 'agent-a', messages, false));
    await waitFor(() => expect(hook.result.current.request?.id).toBe('request-a'));
    await act(async () => {
      await hook.result.current.complete();
    });
    expect(hook.result.current.completing).toBe(true);
    await act(async () => {
      await hook.result.current.complete();
    });
    expect(attempts).toBe(1);
    expect(f.calls.filter((c) => c.endsWith('/auth-assistance/request-a')).length).toBeGreaterThan(
      1,
    );
  },
);

it('retries only the exact initial authenticated read after a transient loss before enabling private input', async () => {
  fixture();
  const original = vi.mocked(fetch).getMockImplementation();
  let reads = 0;
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/auth-assistance/request-a') && reads++ === 0)
      throw new TypeError('synthetic first read loss');
    return original(url, init);
  });
  render(<BrowserStatusBarFullscreen {...props()} />);
  expect(await screen.findByLabelText('Private phone password')).toBeInTheDocument();
  expect(reads).toBe(2);
});

it('reuses the private purpose row for its receipt instead of adding a row that shrinks phone pixels', async () => {
  fixture();
  render(<BrowserStatusBarFullscreen {...props()} />);
  const input = await screen.findByLabelText('Private phone password');
  await waitFor(() => expect(input).toBeEnabled());
  const purpose = within(screen.getByTestId('phone-private-authentication')).getByRole('status');
  fireEvent.change(input, { target: { value: 'PRIVATE-COMPACT-CANARY' } });
  fireEvent.click(screen.getByRole('button', { name: 'Type privately' }));
  expect(await screen.findByText('Typed privately. Check phone, then Done.')).toBe(purpose);
});

it('shows complete unclipped native instructions and receipts in the existing status row', async () => {
  fixture();
  render(<BrowserStatusBarFullscreen {...props()} />);
  const input = await screen.findByLabelText('Private phone password');
  await waitFor(() => expect(input).toBeEnabled());
  const message = within(screen.getByTestId('phone-private-authentication')).getByRole('status');
  expect(message.className).not.toMatch(
    /truncate|line-clamp|overflow-hidden|text-ellipsis|whitespace-nowrap/,
  );
  expect(message).toHaveTextContent('Password: tap phone field, then type.');
  fireEvent.change(input, { target: { value: 'PRIVATE-UNCLIPPED-CANARY' } });
  fireEvent.click(screen.getByRole('button', { name: 'Type privately' }));
  await waitFor(() =>
    expect(message).toHaveTextContent('Typed privately. Check phone, then Done.'),
  );
  expect(message.className).not.toMatch(
    /truncate|line-clamp|overflow-hidden|text-ellipsis|whitespace-nowrap/,
  );
});

// Safe setup status is observed on the existing task interaction, never a new setup poller.
describe('phone setup status', () => {
  const setup = (state: string) => ({
    required: true,
    state,
    attemptId: 'attempt-a',
    revision: 3,
    profileRevision: 5,
    expectedAccountIdentifier: 'PRIVATE-ACCOUNT-CANARY',
    reasonCode: 'PRIVATE-REASON-CANARY',
    lastRequest: { raw: 'PRIVATE-EXTRA-CANARY' },
  });
  const ordinary = () => ({
    ...props(),
    isWaitingForAuthAssistance: false,
    messages: [
      { ...messages[0], metadata: { task_id: 'task-a', toolName: 'phone', action_type: 'phone' } },
    ] as Message[],
  });
  it.each([
    ['not_started', 'Setting up your phone'],
    ['in_progress', 'Setting up your phone'],
    ['awaiting_user', 'Phone setup needs your help'],
    ['verifying', 'Verifying phone setup'],
    ['blocked', 'Phone setup blocked'],
    ['deferred', 'Phone setup deferred'],
    ['ready', 'Phone active'],
  ])('shows only safe authoritative %s phase status', async (state, label) => {
    const f = fixture(
      {},
      { setup: setup(state) },
      { controlOwner: 'agent', attentionRequestId: null },
    );
    render(<BrowserStatusBarFullscreen {...ordinary()} />);
    await waitFor(() =>
      expect(screen.getByTestId('fullscreen-activity-status')).toHaveTextContent(label),
    );
    expect(document.body.innerHTML).not.toMatch(/PRIVATE-(ACCOUNT|REASON|EXTRA)-CANARY/);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByLabelText('Private phone password')).toBeNull();
    expect(screen.queryByText(/Messages ready|SMS ready|iCloud ready/i)).toBeNull();
    expect(f.posts).toEqual([]);
  });
  it.each([
    [{ status: 'WAITING', controlOwner: 'agent' }, false, 'Waiting for phone'],
    [{ controlOwner: 'agent' }, true, 'Read-only phone'],
    [{ controlOwner: 'user' }, false, 'You have phone control'],
  ])('keeps queue/read-only/user precedence %j', async (lease, readOnly, label) => {
    fixture({}, { setup: setup('verifying') }, { attentionRequestId: null, ...lease });
    render(<BrowserStatusBarFullscreen {...ordinary()} readOnly={readOnly} />);
    await waitFor(() =>
      expect(screen.getByTestId('fullscreen-activity-status')).toHaveTextContent(label),
    );
    if (readOnly) expect(screen.queryByRole('button', { name: 'Take phone control' })).toBeNull();
  });
  it('keeps awaiting-user native attention on the exact protected USER form', async () => {
    fixture({}, { setup: setup('awaiting_user') });
    render(<BrowserStatusBarFullscreen {...props()} />);
    expect(await screen.findByLabelText('Private phone password')).toBeInTheDocument();
    expect(screen.getByTestId('fullscreen-activity-status')).toHaveTextContent(
      'You have phone control',
    );
  });
  it('reports an initial setup-required failure without rejection copy or retrying the original input', async () => {
    const failed = {
      id: 'original-agent-op',
      cursor: 1,
      operation: 'input.tap',
      status: 'FAILED',
      errorCode: 'phone_setup_required',
      result: { raw: 'PRIVATE-RESULT-CANARY' },
    };
    const f = fixture(
      {},
      { lastOperation: failed, setup: setup('in_progress') },
      { controlOwner: 'agent', attentionRequestId: null },
    );
    render(<BrowserStatusBarFullscreen {...ordinary()} />);
    await waitFor(() =>
      expect(screen.getByTestId('fullscreen-activity-status')).toHaveTextContent(
        'Setting up your phone',
      ),
    );
    expect(
      screen.queryByText(/request rejected|input was not applied|PRIVATE-RESULT-CANARY/),
    ).toBeNull();
    expect(f.posts).toEqual([]);
  });
  it.each(['RUNNING', 'UNKNOWN'])(
    'shows fenced %s verification without frame requests or connection errors',
    async (status) => {
      const pending = {
        id: 'verify-a',
        cursor: 1,
        operation: 'setup.verify',
        status,
        errorCode: null,
        result: { raw: 'PRIVATE-VERIFY-CANARY' },
      };
      const f = fixture(
        {},
        { pendingOperation: pending, setup: setup('in_progress') },
        { controlOwner: 'agent', attentionRequestId: null },
      );
      render(<BrowserStatusBarFullscreen {...ordinary()} />);
      await waitFor(() =>
        expect(screen.getByTestId('fullscreen-activity-status')).toHaveTextContent(
          'Verifying phone setup',
        ),
      );
      expect(screen.queryByText(/PRIVATE-VERIFY-CANARY/)).toBeNull();
      expect(f.posts).toEqual([]);
      await waitFor(() =>
        expect(f.calls.some((call) => call.endsWith('/operations/verify-a'))).toBe(true),
      );
      expect(f.calls.some((call) => call.endsWith('/frame'))).toBe(false);
      expect(screen.queryByText(/Connecting to the phone|temporarily unavailable/)).toBeNull();
      expect(screen.getAllByText('Verifying phone setup').length).toBeGreaterThan(1);
      expect(screen.getByRole('button', { name: 'Take phone control' })).toBeDisabled();
      await waitFor(
        () =>
          expect(
            f.calls.filter((call) => call.endsWith('/operations/verify-a')).length,
          ).toBeGreaterThan(1),
        { timeout: 2500 },
      );
      expect(f.calls.some((call) => call.endsWith('/frame'))).toBe(false);
    },
  );
});
