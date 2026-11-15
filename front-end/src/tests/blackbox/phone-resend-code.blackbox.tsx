/** One-tap "Resend code": loading until the agent re-asks, then Done with a 60 s cooldown. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { RequestListItem } from '@/features/terminal-component-group/components/attention-inbox/RequestListItem';
import { BrowserStatusBarFullscreen } from '@/features/terminal-component-group/components/browser-status-bar/BrowserStatusBarFullscreen';
import { resetPhoneResendCodeState } from '@/features/terminal-component-group/components/browser-status-bar/phone/usePhoneResendCode';
import type { AttentionRequest } from '@/features/terminal-component-group/components/attention-inbox/types';

vi.mock('@/lib/api/client', () => ({
  API_BASE_WITH_PATH: 'http://localhost:3001/api',
  getAuthHeaders: () => ({ Authorization: 'Bearer synthetic-user' }),
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
import { fixture, props } from './fixtures/phone-attention.fixture';

const target = { kind: 'iphone', browserTaskId: 'task-a', leaseId: 'lease-a' } as const;
const card = (id: string) =>
  ({
    id,
    agent_id: 'agent-a',
    question: 'Enter the Google verification code',
    created_at: '2026-11-15',
    updated_at: '2026-11-15',
    answered: false,
    metadata: {
      attentionKind: 'auth_assistance',
      authAssistance: {
        requestId: id,
        target,
        criticalReason: 'verification_code',
        mode: 'manual_step',
        taskId: 'task-a',
      },
    },
  }) as unknown as AttentionRequest;
const item = (id: string) => (
  <RequestListItem
    request={card(id)}
    remainingCount={0}
    responseText=""
    loading={false}
    actionRequestId={null}
    onSelectAgent={vi.fn()}
    onClose={vi.fn()}
    onChangeResponse={vi.fn()}
    onAccept={vi.fn()}
    onSkip={vi.fn()}
    onReject={vi.fn()}
    onSendViaIMessage={vi.fn()}
  />
);
function stubResend(status = 200) {
  const posts: Array<{ url: string; body: unknown }> = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      await held;
      return new Response('{}', { status });
    }),
  );
  return { posts, release };
}

beforeEach(() => {
  resetPhoneResendCodeState();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetPhoneResendCodeState();
});

it('resend code: one tap, loading until the agent re-asks, Done, then 60 s cooldown', async () => {
  vi.useFakeTimers();
  const http = stubResend();
  const view = render(item('request-a'));
  const button = screen.getByRole('button', { name: 'Resend code' });
  expect(button).toBeEnabled();
  fireEvent.click(button);
  fireEvent.click(button);
  const loading = screen.getByRole('button', { name: 'Resending code' });
  expect(loading).toBeDisabled();
  expect(loading).toHaveAttribute('aria-busy', 'true');
  expect(http.posts).toEqual([
    {
      url: 'http://localhost:3001/api/auth-assistance/request-a/complete',
      body: { action: 'resend_code' },
    },
  ]);
  await act(async () => {
    http.release();
  });
  // The accepted POST alone is not "sent": wait for the agent to raise the next code request.
  await act(async () => {
    vi.advanceTimersByTime(30_000);
  });
  expect(screen.getByRole('button', { name: 'Resending code' })).toBeDisabled();
  view.rerender(item('request-b'));
  const done = screen.getByRole('button', { name: /^Code resent/ });
  expect(done).toHaveTextContent('Done');
  expect(done).toBeDisabled();
  await act(async () => {
    vi.advanceTimersByTime(59_000);
  });
  expect(screen.getByRole('button', { name: /^Code resent/ })).toBeDisabled();
  await act(async () => {
    vi.advanceTimersByTime(1_000);
  });
  expect(screen.getByRole('button', { name: 'Resend code' })).toBeEnabled();
  expect(http.posts).toHaveLength(1);
});

it('resend code: a rejected resend returns to an enabled button with a notice', async () => {
  const http = stubResend(409);
  render(item('request-a'));
  fireEvent.click(screen.getByRole('button', { name: 'Resend code' }));
  await act(async () => {
    http.release();
  });
  expect(await screen.findByRole('button', { name: 'Resend code' })).toBeEnabled();
  expect(screen.getByText('Resend was not accepted. Check the phone.')).toBeInTheDocument();
});

it('resend code: the live phone overlay offers it on the pending code step and shares the press', async () => {
  const f = fixture({ criticalReason: 'verification_code' });
  const base = globalThis.fetch;
  const resends: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/auth-assistance/request-a/complete') && init?.body) {
        resends.push(JSON.parse(String(init.body)));
        return new Response('{}', { status: 200 });
      }
      return base(url, init);
    }),
  );
  render(<BrowserStatusBarFullscreen {...props()} />);
  await screen.findByLabelText('Private phone verification code');
  const button = await screen.findByRole('button', { name: 'Resend code' });
  fireEvent.click(button);
  expect(await screen.findByRole('button', { name: 'Resending code' })).toBeDisabled();
  expect(resends).toEqual([{ action: 'resend_code' }]);
  expect(f.calls.filter((c) => c.startsWith('POST') && c.endsWith('/complete'))).toHaveLength(0);
  render(item('request-a'));
  expect(screen.getAllByRole('button', { name: 'Resending code' })).toHaveLength(2);
});

it('resend code: shown only while a native iPhone manual_step request is pending', async () => {
  const browserCard = {
    ...card('request-web'),
    metadata: {
      attentionKind: 'auth_assistance',
      authAssistance: {
        requestId: 'request-web',
        mode: 'live_view',
        liveViewUrl: 'https://live.test',
      },
    },
  } as unknown as AttentionRequest;
  const view = render(
    <RequestListItem
      request={browserCard}
      remainingCount={0}
      responseText=""
      loading={false}
      actionRequestId={null}
      onSelectAgent={vi.fn()}
      onClose={vi.fn()}
      onChangeResponse={vi.fn()}
      onAccept={vi.fn()}
      onSkip={vi.fn()}
      onReject={vi.fn()}
      onSendViaIMessage={vi.fn()}
    />,
  );
  expect(screen.getByRole('button', { name: 'Open Live Browser' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Resend code' })).toBeNull();
  view.unmount();
  // Phone visible but no pending native request on the lease: no Resend code.
  fixture(
    { criticalReason: 'verification_code' },
    {},
    { attentionRequestId: null, controlOwner: 'agent' },
  );
  const overlay = render(<BrowserStatusBarFullscreen {...props()} />);
  await screen.findByRole('region', { name: 'Cloud iPhone' });
  await screen.findByText('Agent in progress');
  expect(screen.queryByRole('button', { name: 'Resend code' })).toBeNull();
  overlay.unmount();
  // Completed request (agent verifying, no resend in flight): no Resend code.
  fixture({ criticalReason: 'verification_code', completedAt: '2026-11-15T06:00:00Z' });
  render(<BrowserStatusBarFullscreen {...props()} />);
  await screen.findByText('Authentication complete. Agent will verify sign-in.');
  expect(screen.queryByRole('button', { name: 'Resend code' })).toBeNull();
});
