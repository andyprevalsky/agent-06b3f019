/** Phone overlay: dormant -> task-triggered -> waiting|active -> released; user control is broker-confirmed. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { snapshot } from '@amplitude/rrweb-snapshot';
import { createPrivacyRecorderOptions } from '@amplitude/session-replay-dom-privacy';
import { PhoneOverlay } from '@/features/terminal-component-group/components/browser-status-bar/phone/PhoneOverlay';
import type { PhoneOverlayModel } from '@/features/terminal-component-group/components/browser-status-bar/phone/usePhoneOverlay';
import { emptyView } from '@/features/terminal-component-group/components/browser-status-bar/phone/phoneOverlaySession';
import { server } from './msw/server';
import { BrowserStatusBarFullscreen } from '@/features/terminal-component-group/components/browser-status-bar/BrowserStatusBarFullscreen';
import type { Message } from '@/features/terminal-component-group/hooks';

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mobile.value }));
vi.mock('@/lib/api/client', () => ({
  API_BASE_WITH_PATH: 'http://localhost:3001/api',
  getAuthHeaders: () => ({
    Authorization: 'Bearer synthetic-user',
    'Content-Type': 'application/json',
  }),
}));
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

const api = 'http://localhost:3001/api/iphone';
const frameHeaders = { 'Content-Type': 'image/png' };
const advancePhoneTime = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const waitForPhone = (assertion: () => void) => vi.waitFor(assertion, { timeout: 5000 });
const phoneMessage = {
  message_id: 'phone-event',
  timestamp: '2026-10-18T20:00:00Z',
  role: 'TOOL',
  text: 'Using phone',
  metadata: { task_id: 'task-a', toolName: 'phone', action_type: 'phone' },
} as Message;
function props(overrides: Partial<React.ComponentProps<typeof BrowserStatusBarFullscreen>> = {}) {
  return {
    taskId: 'task-a',
    agentId: 'agent-a',
    browserUrl: 'https://example.com/browser-same-session',
    messages: [phoneMessage],
    outputSchema: undefined,
    browserSessionMetadata: null,
    stepProgress: null,
    isDisconnected: false,
    isWaitingForAuthAssistance: false,
    isResuming: false,
    isUserControlling: false,
    pendingWriteLockApproval: null,
    onClose: vi.fn(),
    onResume: vi.fn(),
    ...overrides,
  };
}
function fixture(status = 'ACTIVE') {
  let snapshot = {
    lease: {
      id: 'lease-a',
      agentId: 'agent-a',
      browserTaskId: 'task-a',
      status,
      queuePosition: status === 'WAITING' ? 2 : null,
      queueDeadlineAt: '2026-10-18T20:05:00Z',
      leaseExpiresAt: '2026-10-18T20:10:00Z',
      controlOwner: 'agent',
      attentionRequestId: null,
      revision: 1,
    },
    cursor: 7,
    lastOperation: null,
    pendingOperation: null,
  };
  const reads: string[] = [];
  const writes: Array<{
    operationId: string;
    operation: string;
    args: Record<string, unknown>;
    expectedCursor: number;
  }> = [];
  const controls: string[] = [];
  let frames = 0;
  server.use(
    http.get(`${api}/interactions/:taskId`, ({ params }) => {
      reads.push(String(params.taskId));
      return HttpResponse.json(snapshot);
    }),
    http.get(`${api}/leases/lease-a/frame`, ({ request }) => {
      expect(request.headers.get('authorization')).toBe('Bearer synthetic-user');
      frames++;
      return new HttpResponse(new Uint8Array([137, 80, 78, 71]), { headers: frameHeaders });
    }),
    http.post(`${api}/leases/lease-a/control`, async ({ request }) => {
      const body = (await request.json()) as { mode: string };
      controls.push(body.mode);
      snapshot = {
        ...snapshot,
        lease: {
          ...snapshot.lease,
          controlOwner: body.mode,
          revision: snapshot.lease.revision + 1,
        },
      };
      return HttpResponse.json(snapshot);
    }),
    http.post(`${api}/leases/lease-a/operations`, async ({ request }) => {
      const body = (await request.json()) as (typeof writes)[number];
      writes.push(body);
      snapshot.cursor++;
      return HttpResponse.json({
        operation: {
          id: body.operationId,
          cursor: snapshot.cursor,
          operation: body.operation,
          status: 'SUCCEEDED',
          errorCode: null,
          result:
            body.operation === 'screen.bounds' ? { x: 40, y: 60, w: 430, h: 932, id: 9 } : null,
        },
      });
    }),
  );
  return {
    interaction: () => snapshot,
    reads,
    writes,
    controls,
    get frames() {
      return frames;
    },
    setStatus(next: string) {
      snapshot = { ...snapshot, lease: { ...snapshot.lease, status: next } };
    },
  };
}

beforeEach(() => {
  mobile.value = false;
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:private-phone-frame');
      static revokeObjectURL = vi.fn();
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('native phone overlay above the owned browser', () => {
  it.each([false, true])('keeps the browser phone-idle (foreign=%s)', async (foreign) => {
    const f = fixture();
    const messages = foreign
      ? [{ ...phoneMessage, metadata: { task_id: 'foreign', toolName: 'phone' } }]
      : [];
    const view = render(<BrowserStatusBarFullscreen {...props({ messages })} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect([f.reads, f.writes, f.controls, f.frames]).toEqual([[], [], [], 0]);
    expect(screen.queryByTestId('fullscreen-global-controls-slot')).toBeNull();
    expect(screen.queryByText(/phone control|Phone active|Setting up/)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Cloud iPhone' })).not.toBeInTheDocument();
    view.unmount();
  });

  it('shows private phone frames above the same mounted browser, restoring it after release', async () => {
    const f = fixture();
    render(<BrowserStatusBarFullscreen {...props()} />);
    const browser = screen.getByTitle('Browser');
    expect(await screen.findByRole('region', { name: 'Cloud iPhone' })).toBeInTheDocument();
    const frame = await screen.findByAltText('Cloud iPhone screen');
    expect(frame).toHaveAttribute('src', 'blob:private-phone-frame');
    expect(browser).toHaveAttribute('inert');
    expect(screen.getByText('Task progress')).toBeInTheDocument();
    f.setStatus('RELEASED');
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Cloud iPhone' })).not.toBeInTheDocument(),
    );
    expect(screen.getByTitle('Browser')).toBe(browser);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:private-phone-frame');
  });

  it('shows FIFO position and deadline while queued without fetching frames or writing', async () => {
    const f = fixture('WAITING');
    render(<BrowserStatusBarFullscreen {...props()} />);
    expect(await screen.findByText(/Queue position 2/i)).toBeInTheDocument();
    expect(screen.getByText(/five minutes/i)).toBeInTheDocument();
    expect(screen.getByTestId('phone-queue-deadline')).toHaveAttribute(
      'dateTime',
      '2026-10-18T20:05:00Z',
    );
    expect(f.frames).toBe(0);
    expect(f.writes).toEqual([]);
    expect(f.controls).toEqual([]);
  });

  it('replaces the mobile browser footer with phone controls while keeping progress', async () => {
    mobile.value = true;
    fixture();
    render(<BrowserStatusBarFullscreen {...props()} />);
    expect(await screen.findByRole('region', { name: 'Cloud iPhone' })).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-browser-control-footer')).not.toBeInTheDocument();
    expect(screen.getByText('Task progress')).toBeInTheDocument();
    expect(screen.getByTestId('phone-controls')).toBeInTheDocument();
  });

  it('confirms takeover then reads point bounds before mapping input; handback uses the broker', async () => {
    const f = fixture();
    render(<BrowserStatusBarFullscreen {...props()} />);
    const take = await screen.findByRole('button', { name: 'Take phone control' });
    fireEvent.click(take);
    const tap = await screen.findByRole('button', { name: 'Tap cloud iPhone screen' });
    await waitFor(() => expect(tap).toBeEnabled());
    const image = screen.getByAltText('Cloud iPhone screen');
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({
      left: 10,
      top: 20,
      width: 215,
      height: 466,
      right: 225,
      bottom: 486,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    });
    fireEvent.click(tap, { clientX: 117.5, clientY: 253 });
    await waitFor(() => expect(f.writes.some((w) => w.operation === 'input.tap')).toBe(true));
    const input = f.writes.find((w) => w.operation === 'input.tap');
    expect(input.args).toEqual({ x: 255, y: 526 });
    expect(input.expectedCursor).toBeGreaterThan(7);
    expect(new Set(f.writes.map((w) => w.operationId)).size).toBe(f.writes.length);
    expect(f.writes[0].operation).toBe('screen.bounds');
    fireEvent.click(screen.getByRole('button', { name: 'Hand back phone control' }));
    await waitFor(() => expect(f.controls).toEqual(['user', 'agent']));
  });

  it('keeps read-only phone viewing passive', async () => {
    const f = fixture();
    render(<BrowserStatusBarFullscreen {...props({ readOnly: true })} />);
    expect(await screen.findByAltText('Cloud iPhone screen')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take phone control' })).not.toBeInTheDocument();
    expect(f.writes).toEqual([]);
    expect(f.controls).toEqual([]);
  });
});

it('aborts owned frame requests and revokes blobs on hide, with no hidden polling', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = fixture();
  const view = render(<BrowserStatusBarFullscreen {...props()} />);
  await waitForPhone(() => expect(screen.getByAltText('Cloud iPhone screen')).toBeInTheDocument());
  let release: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const aborted = vi.fn();
  let started = false;
  server.use(
    http.get(`${api}/leases/lease-a/frame`, async ({ request }) => {
      started = true;
      request.signal.addEventListener('abort', aborted);
      await held;
      return new HttpResponse(new Uint8Array([137, 80, 78, 71]), { headers: frameHeaders });
    }),
  );
  await waitForPhone(() => expect(started).toBe(true));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  fireEvent(document, new Event('visibilitychange'));
  await waitForPhone(() => expect(aborted).toHaveBeenCalledOnce());
  expect(screen.queryByAltText('Cloud iPhone screen')).not.toBeInTheDocument();
  expect(URL.revokeObjectURL).toHaveBeenCalled();
  const reads = f.reads.length;
  release();
  await advancePhoneTime(1100);
  expect(f.reads.length).toBe(reads);
  view.unmount();
  vi.restoreAllMocks();
});

it('never overlaps frame requests and drops a late frame after task replacement', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fixture();
  let release: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0,
    maxActive = 0;
  const aborted = vi.fn();
  server.use(
    http.get(`${api}/leases/lease-a/frame`, async ({ request }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      request.signal.addEventListener('abort', aborted);
      await held;
      active--;
      return new HttpResponse(new Uint8Array([137, 80, 78, 71]), { headers: frameHeaders });
    }),
  );
  const view = render(<BrowserStatusBarFullscreen {...props()} />);
  await waitForPhone(() => expect(active).toBe(1));
  await advancePhoneTime(1100);
  expect(maxActive).toBe(1);
  view.rerender(<BrowserStatusBarFullscreen {...props({ taskId: 'task-b', messages: [] })} />);
  await waitForPhone(() => expect(aborted).toHaveBeenCalledOnce());
  release();
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByAltText('Cloud iPhone screen')).not.toBeInTheDocument();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('uses status recovery for an unknown mutation with its original ID and never replays it', async () => {
  fixture();
  const inputs: string[] = [];
  const statuses: string[] = [];
  server.use(
    http.post(`${api}/leases/lease-a/operations`, async ({ request }) => {
      const command = (await request.json()) as { operationId: string; operation: string };
      if (command.operation === 'screen.bounds')
        return HttpResponse.json({
          operation: {
            id: command.operationId,
            cursor: 8,
            operation: command.operation,
            status: 'SUCCEEDED',
            result: { x: 0, y: 0, w: 430, h: 932 },
          },
        });
      inputs.push(command.operationId);
      return HttpResponse.error();
    }),
    http.get(`${api}/leases/lease-a/operations/:operationId`, ({ params }) => {
      statuses.push(String(params.operationId));
      return HttpResponse.json({
        operation: {
          id: params.operationId,
          cursor: 9,
          operation: 'nav.home',
          status: 'UNKNOWN',
          result: null,
        },
      });
    }),
  );
  render(<BrowserStatusBarFullscreen {...props()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Take phone control' }));
  const home = await screen.findByRole('button', { name: 'Home' });
  await waitFor(() => expect(home).toBeEnabled());
  fireEvent.click(home);
  await waitFor(() => expect(inputs).toHaveLength(1));
  await waitFor(() => expect(statuses).toContain(inputs[0]));
  expect(home).toBeDisabled();
  fireEvent.click(home);
  expect(inputs).toHaveLength(1);
  expect(screen.getByText(/New input is disabled/)).toBeInTheDocument();
});

it('does not replay stale-cursor input and waits for fresh bounds', async () => {
  fixture();
  let inputs = 0,
    boundReads = 0;
  server.use(
    http.post(`${api}/leases/lease-a/operations`, async ({ request }) => {
      const command = (await request.json()) as { operationId: string; operation: string };
      if (command.operation === 'screen.bounds') {
        boundReads++;
        return HttpResponse.json({
          operation: {
            id: command.operationId,
            cursor: 8,
            operation: command.operation,
            status: 'SUCCEEDED',
            result: { x: 0, y: 0, w: 430, h: 932 },
          },
        });
      }
      inputs++;
      return HttpResponse.json({ error: 'Phone state changed' }, { status: 409 });
    }),
  );
  render(<BrowserStatusBarFullscreen {...props()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Take phone control' }));
  const home = await screen.findByRole('button', { name: 'Home' });
  await waitFor(() => expect(home).toBeEnabled());
  fireEvent.click(home);
  await waitFor(() => expect(inputs).toBe(1));
  expect(home).toBeDisabled();
  await waitFor(() => expect(boundReads).toBeGreaterThan(1));
  expect(inputs).toBe(1);
});

it('shows the server queue timeout instead of silently treating expiry as release', async () => {
  const f = fixture('WAITING');
  render(<BrowserStatusBarFullscreen {...props()} />);
  await screen.findByText(/Queue position 2/);
  f.setStatus('EXPIRED');
  expect(await screen.findByRole('status', { name: 'Phone queue timed out' })).toHaveTextContent(
    /agent decides/i,
  );
  expect(screen.queryByRole('region', { name: 'Cloud iPhone' })).not.toBeInTheDocument();
});

it('keeps text entry collapsed until requested, with a visible field label', async () => {
  fixture();
  render(<BrowserStatusBarFullscreen {...props()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Take phone control' }));
  await screen.findByRole('button', { name: 'Home' });
  expect(screen.queryByRole('textbox', { name: 'Text to type on phone' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Type' }));
  expect(screen.getByPlaceholderText('Text to type')).toBeInTheDocument();
});

it('maps only painted image points inside letterboxing using actual bounds origin', async () => {
  const f = fixture();
  render(<BrowserStatusBarFullscreen {...props()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Take phone control' }));
  const tap = await screen.findByRole('button', { name: 'Tap cloud iPhone screen' });
  await waitFor(() => expect(tap).toBeEnabled());
  const image = screen.getByAltText('Cloud iPhone screen');
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1200 });
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 2400 });
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({
    left: 10,
    top: 20,
    width: 300,
    height: 300,
    right: 310,
    bottom: 320,
    x: 10,
    y: 20,
    toJSON: () => ({}),
  });
  fireEvent.click(tap, { clientX: 20, clientY: 170 });
  expect(f.writes.filter((w) => w.operation === 'input.tap')).toHaveLength(0);
  fireEvent.click(tap, { clientX: 160, clientY: 170 });
  await waitFor(() => expect(f.writes.filter((w) => w.operation === 'input.tap')).toHaveLength(1));
  expect(f.writes.find((w) => w.operation === 'input.tap').args).toEqual({ x: 255, y: 526 });
});

it('reports phone queue and confirmed user control in the fullscreen header', async () => {
  mobile.value = true;
  const f = fixture('WAITING');
  render(<BrowserStatusBarFullscreen {...props()} />);
  await screen.findByText(/Queue position 2/);
  expect(screen.queryByText('Active')).not.toBeInTheDocument();
  expect(screen.getByText('Waiting for phone')).toBeInTheDocument();
  f.setStatus('ACTIVE');
  fireEvent.click(await screen.findByRole('button', { name: 'Take phone control' }));
  await waitFor(() =>
    expect(screen.getByTestId('fullscreen-activity-status')).toHaveTextContent(
      'You have phone control',
    ),
  );
});

it('supports a keyboard center tap using fresh point bounds and focuses explicit text entry', async () => {
  const f = fixture();
  render(<BrowserStatusBarFullscreen {...props()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Take phone control' }));
  const tap = await screen.findByRole('button', { name: 'Tap cloud iPhone screen' });
  await waitFor(() => expect(tap).toBeEnabled());
  fireEvent.click(tap, { detail: 0, clientX: 0, clientY: 0 });
  await waitFor(() => expect(f.writes.some((w) => w.operation === 'input.tap')).toBe(true));
  expect(f.writes.find((w) => w.operation === 'input.tap').args).toEqual({ x: 255, y: 526 });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Type' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Type' }));
  expect(screen.getByRole('textbox', { name: 'Text to type on phone' })).toHaveFocus();
});

it('reports rejected preparation as input not applied, clears submitted text, and never replays it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fixture();
  let textPosts = 0;
  server.use(
    http.post(`${api}/leases/lease-a/operations`, async ({ request }) => {
      const command = (await request.json()) as { operationId: string; operation: string };
      if (command.operation === 'screen.bounds')
        return HttpResponse.json({
          operation: {
            id: command.operationId,
            cursor: 8,
            operation: command.operation,
            status: 'SUCCEEDED',
            result: { x: 0, y: 0, w: 430, h: 932 },
          },
        });
      textPosts++;
      return HttpResponse.json({
        operation: {
          id: command.operationId,
          cursor: 9,
          operation: command.operation,
          status: 'FAILED',
          errorCode: 'phone_connection_not_ready',
          result: {
            success: false,
            outcome: 'rejected',
            error: 'PRIVATE-PROVIDER-DETAIL sensitive-synthetic-input',
          },
        },
      });
    }),
  );
  render(<BrowserStatusBarFullscreen {...props()} />);
  await waitForPhone(() =>
    expect(screen.getByRole('button', { name: 'Take phone control' })).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Take phone control' }));
  await waitForPhone(() => expect(screen.getByRole('button', { name: 'Type' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Type' }));
  const field = screen.getByRole('textbox', { name: 'Text to type on phone' });
  fireEvent.change(field, { target: { value: 'sensitive-synthetic-input' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send text' }));
  await waitForPhone(() =>
    expect(screen.getByText(/Phone input was not applied/)).toBeInTheDocument(),
  );
  expect(field).toHaveValue('');
  expect(screen.queryByText(/PRIVATE-PROVIDER-DETAIL/)).not.toBeInTheDocument();
  await advancePhoneTime(1100);
  expect(textPosts).toBe(1);
  expect(screen.getByText(/Phone input was not applied/)).toBeInTheDocument();
});

it('does not claim input was unapplied for an unrelated FAILED receipt', async () => {
  fixture();
  server.use(
    http.post(`${api}/leases/lease-a/operations`, async ({ request }) => {
      const command = (await request.json()) as { operationId: string; operation: string };
      return HttpResponse.json({
        operation: {
          id: command.operationId,
          cursor: 8,
          operation: command.operation,
          status: command.operation === 'screen.bounds' ? 'SUCCEEDED' : 'FAILED',
          errorCode: 'phone_command_failed',
          result:
            command.operation === 'screen.bounds'
              ? { x: 0, y: 0, w: 430, h: 932 }
              : { error: 'PRIVATE-PROVIDER-DETAIL' },
        },
      });
    }),
  );
  render(<BrowserStatusBarFullscreen {...props()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Take phone control' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Home' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Home' }));
  expect(await screen.findByText(/Phone request rejected. Check the screen/)).toBeInTheDocument();
  expect(screen.queryByText(/Phone input was not applied/)).not.toBeInTheDocument();
  expect(screen.queryByText(/PRIVATE-PROVIDER-DETAIL/)).not.toBeInTheDocument();
});

// Use the installed Session Replay SDK's own recorder policy, not a local selector imitation.
describe('phone overlay recorder privacy', () => {
  it.each(['agent', 'user', 'readOnly', 'queue'] as const)(
    'excludes the real %s phone subtree, including image, input and echoed status',
    (state) => {
      const canary = 'UNREGISTERED-PHONE-REPLAY-CANARY-6a';
      const frame = `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg"><text>${canary}</text></svg>`)}`;
      const interaction = fixture(state === 'queue' ? 'WAITING' : 'ACTIVE').interaction();
      interaction.lease.controlOwner = state === 'user' ? 'user' : 'agent';
      const phone: PhoneOverlayModel = {
        ...emptyView('task-a'),
        visible: true,
        frame: state === 'queue' ? null : frame,
        bounds: { x: 0, y: 0, w: 430, h: 932 },
        notice: canary,
        snapshot: interaction as PhoneOverlayModel['snapshot'],
        control: vi.fn(),
        input: vi.fn(),
        invalidateBounds: vi.fn(),
        refreshView: vi.fn(),
      };
      render(
        <>
          <button>Public browser status</button>
          <PhoneOverlay phone={phone} readOnly={state === 'readOnly'} />
        </>,
      );
      const region = screen.getByRole('region', { name: 'Cloud iPhone' });
      expect(region).toHaveAttribute('data-amp-block', '');
      expect(region).toHaveAttribute('data-amp-mask', '');
      expect(region).toContainElement(screen.getByText(canary));
      if (state !== 'queue') {
        const image = screen.getByAltText('Cloud iPhone screen');
        expect(image.closest('[data-amp-block]')).toBe(region);
      }
      if (state === 'user') {
        fireEvent.click(screen.getByRole('button', { name: 'Type' }));
        const input = screen.getByRole('textbox', { name: 'Text to type on phone' });
        fireEvent.change(input, { target: { value: canary } });
        expect(input).toHaveValue(canary);
        expect(input.closest('[data-amp-block]')).toBe(region);
      }
      const serialized = JSON.stringify(snapshot(document, createPrivacyRecorderOptions()));
      expect(serialized).toContain('Public browser status');
      expect(serialized).not.toContain(canary);
      expect(serialized).not.toContain(frame);
      expect(serialized).not.toContain('"tagName":"img"');
      expect(serialized).not.toContain('"tagName":"input"');
    },
  );
});
