/** Native attention must resolve an exact authenticated target before private user input. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
const target = { kind: 'iphone', browserTaskId: 'task-a', leaseId: 'lease-a' };
const meta = {
  requestId: 'request-a',
  target,
  criticalReason: 'password',
  handoffMode: 'manual_step',
  taskId: 'task-a',
};
const messages = [
  {
    message_id: 'attention-a',
    timestamp: 'now',
    role: 'TOOL',
    text: '',
    metadata: {
      task_id: 'task-a',
      toolStatus: 'IN_PROGRESS',
      action_type: 'auth_assistance',
      requestUserAuthentication: meta,
    },
  },
] as Message[];
const props = () => ({
  taskId: 'task-a',
  agentId: 'agent-a',
  browserUrl: 'https://example.com/browser',
  messages,
  outputSchema: undefined,
  browserSessionMetadata: null,
  stepProgress: null,
  isDisconnected: false,
  isWaitingForAuthAssistance: true,
  isResuming: false,
  isUserControlling: false,
  pendingWriteLockApproval: null,
  onClose: vi.fn(),
  onResume: vi.fn(),
});
function fixture(overrides: Record<string, unknown> = {}) {
  let completedAt: string | null = null;
  let pending: Record<string, unknown> | null = null;
  let unknown = false;
  let completeLost = false;
  const posts: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  let cursor = 0;
  const request = () => ({
    id: 'request-a',
    agentId: 'agent-a',
    mode: 'manual_step',
    target,
    criticalReason: 'password',
    completedAt,
    ...overrides,
  });
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.endsWith('/auth-assistance/request-a'))
        return json({
          request: request(),
          handoff: { type: 'manual_step', target, criticalReason: 'password' },
        });
      if (path.endsWith('/auth-assistance/request-a/complete')) {
        expect(init?.body).toBeUndefined();
        completedAt = '2026-10-18T22:00:00Z';
        if (completeLost) throw new TypeError('synthetic lost response');
        return json({ success: true });
      }
      if (path.endsWith('/iphone/interactions/task-a'))
        return json({
          lease: {
            id: 'lease-a',
            agentId: 'agent-a',
            browserTaskId: 'task-a',
            status: 'ACTIVE',
            controlOwner: 'user',
            attentionRequestId: completedAt ? null : 'request-a',
            revision: 1,
          },
          cursor,
          lastOperation: null,
          pendingOperation: pending,
        });
      if (path.endsWith('/frame'))
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'Content-Type': 'image/png' },
        });
      if (path.endsWith('/operations') && init?.method === 'POST') {
        const command = JSON.parse(String(init.body));
        posts.push(command);
        cursor++;
        expect(command.attentionRequestId).toBe('request-a');
        const operation = {
          id: command.operationId,
          cursor,
          operation: command.operation,
          status: 'SUCCEEDED',
          errorCode: null,
          result:
            command.operation === 'screen.bounds'
              ? { x: 0, y: 0, w: 430, h: 932 }
              : { success: true, private: true },
        };
        if (unknown && command.operation === 'input.text') {
          pending = { ...operation, status: 'UNKNOWN' };
          throw new TypeError('synthetic lost response');
        }
        return json({ operation });
      }
      if (path.includes('/operations/')) return json({ operation: pending });
      throw new Error(`Unexpected fixture route ${path}`);
    }),
  );
  return {
    posts,
    calls,
    request,
    setUnknown: (value: boolean) => {
      unknown = value;
    },
    setCompleteLost: () => {
      completeLost = true;
    },
  };
}
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
  const complete = await screen.findByRole('button', { name: 'Authentication complete' });
  await waitFor(() => expect(complete).toBeEnabled());
  fireEvent.click(complete);
  fireEvent.click(complete);
  expect(await screen.findByText(/Agent will verify/)).toBeInTheDocument();
  expect(f.calls.filter((c) => c.startsWith('POST') && c.endsWith('/complete'))).toHaveLength(1);
  expect(parent.onResume).not.toHaveBeenCalled();
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
  const { default: Carousel } =
    await import('@/features/terminal-component-group/components/BrowserStatusBarCarousel');
  const f = fixture();
  window.history.replaceState(
    {},
    '',
    '/?agent-id=agent-a&browser-id=missing-task&attention-request-id=request-a',
  );
  render(<Carousel browsers={[{ taskId: 'task-a', browserUrl: 'https://example.com/browser' }]} />);
  expect(
    await screen.findByRole('status', { name: 'Phone authentication link status' }),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(
      screen.getByRole('status', { name: 'Phone authentication link status' }),
    ).toHaveTextContent(/stale|match/i),
  );
  expect(screen.queryByTitle('Browser')).toBeNull();
  expect(f.posts).toEqual([]);
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
