/**
 * Phone app DEVICE VIEW: the account iPhone's live screen, whoever is using it.
 *
 *  - frames come from GET /iphone/device/frame (single-flight ~1 s); no lease,
 *    interaction, control or operation request is ever made
 *  - the footer names the holder ("In use by agent <id>", linked) or "Idle"
 *  - 409 busy keeps the last frame; 409 private drops it
 *  - STARTING / IDLE copy; frame reads stop while the phone is idle
 *  - an agent whose lease is WAITING sees the live device screen and
 *    "Queued behind agent <id> (position N)" instead of a queue placeholder
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';

import { RoseAppIcons } from '@/features/terminal-component-group';
import { PhoneOverlay } from '@/features/terminal-component-group/components/browser-status-bar/phone/PhoneOverlay';
import { emptyView } from '@/features/terminal-component-group/components/browser-status-bar/phone/phoneOverlaySession';
import type { PhoneOverlayModel } from '@/features/terminal-component-group/components/browser-status-bar/phone/usePhoneOverlay';

import { capturedRequests } from './msw/capture';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import { mockTerminalHookSession } from './terminal-hooks.fixtures';

const API = 'http://localhost:3001/api/iphone';
const HOLDER = 'abcdef12-0000-4000-8000-000000000001';
const PNG = new Uint8Array([137, 80, 78, 71]);

type Frame = 'png' | 'busy' | 'private' | 'IDLE' | 'STARTING';
function device(initial: { providerState: string; holder: string | null; frame: Frame }) {
  const state = { ...initial, frames: 0, inFlight: 0, maxInFlight: 0, frameDelay: 0 };
  server.use(
    http.get(`${API}/device`, () =>
      HttpResponse.json({
        enabled: true,
        setupState: 'ready',
        providerState: state.providerState,
        holder:
          state.holder === null
            ? null
            : { agentId: state.holder, leaseId: 'lease-x', controlOwner: 'agent', since: '' },
        waiting: [],
      }),
    ),
    http.get(`${API}/device/frame`, async () => {
      state.frames += 1;
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        if (state.frameDelay > 0) await delay(state.frameDelay);
        if (state.frame === 'png')
          return new HttpResponse(PNG, { headers: { 'Content-Type': 'image/png' } });
        return HttpResponse.json({ error: 'unavailable', state: state.frame }, { status: 409 });
      } finally {
        state.inFlight -= 1;
      }
    }),
  );
  return state;
}
const leaseOrQueueRequests = () =>
  capturedRequests.filter((r) =>
    /\/(leases|interactions|control|operations)(\/|$)/.test(new URL(r.url).pathname),
  );

let objectUrls = 0;
beforeEach(() => {
  mockTerminalHookSession();
  objectUrls = 0;
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => `blob:frame-${++objectUrls}`);
      static revokeObjectURL = vi.fn();
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function openPhone() {
  renderWithProviders(<RoseAppIcons />);
  await userEvent.click(screen.getByTestId('rose-app-phone'));
  return within(screen.getByTestId('rose-phone')).getByTestId('phone-device-view');
}

describe('Phone app device view', () => {
  it('streams frames from /device/frame single-flight, names the holder, and never touches a lease', async () => {
    const state = device({ providerState: 'READY', holder: HOLDER, frame: 'png' });
    state.frameDelay = 1_300;
    const view = await openPhone();
    const frame = await within(view).findByTestId('phone-device-frame', {}, { timeout: 4000 });
    expect(frame).toHaveAttribute('src', 'blob:frame-1');
    await waitFor(() => expect(frame).toHaveAttribute('src', 'blob:frame-2'), { timeout: 5000 });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:frame-1');
    expect(state.maxInFlight).toBe(1);
    expect(within(view).getByTestId('phone-device-holder')).toHaveTextContent(
      'In use by agent abcdef12',
    );
    expect(within(view).getByRole('link', { name: 'agent abcdef12' })).toHaveAttribute(
      'href',
      `/?agent-id=${HOLDER}`,
    );
    expect(within(view).queryAllByRole('button')).toHaveLength(0);
    expect(leaseOrQueueRequests()).toEqual([]);
  }, 15_000);

  it('keeps the last frame while busy and drops it when the screen turns private', async () => {
    const state = device({ providerState: 'READY', holder: HOLDER, frame: 'png' });
    const view = await openPhone();
    const frame = await within(view).findByTestId('phone-device-frame', {}, { timeout: 4000 });
    state.frame = 'busy';
    const before = state.frames;
    await waitFor(() => expect(state.frames).toBeGreaterThan(before + 1), { timeout: 4000 });
    expect(frame).toBeInTheDocument();
    expect(frame).toHaveAttribute('data-frame-state', 'busy');
    const kept = frame.getAttribute('src');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(kept);
    state.frame = 'private';
    expect(
      await within(view).findByText('Phone screen is private right now.', {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(within(view).queryByTestId('phone-device-frame')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(kept);
    expect(leaseOrQueueRequests()).toEqual([]);
  }, 15_000);

  it('shows boot-up, then idle copy, and stops reading frames while the phone is idle', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const state = device({ providerState: 'STARTING', holder: null, frame: 'STARTING' });
    renderWithProviders(<RoseAppIcons />);
    fireEvent.click(screen.getByTestId('rose-app-phone'));
    const view = within(screen.getByTestId('rose-phone')).getByTestId('phone-device-view');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await vi.waitFor(
      () => expect(within(view).getByText('Booting the phone…')).toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(within(view).getByTestId('phone-device-holder')).toHaveTextContent(/^Idle$/);
    await vi.waitFor(() => expect(state.frames).toBeGreaterThan(0), { timeout: 5000 });
    state.providerState = 'IDLE';
    state.frame = 'IDLE';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await vi.waitFor(() => expect(within(view).getByText('Phone is idle')).toBeInTheDocument(), {
      timeout: 5000,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_200);
    });
    const idleFrames = state.frames;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_200);
    });
    expect(state.frames).toBe(idleFrames);
    expect(leaseOrQueueRequests()).toEqual([]);
  }, 20_000);
});

describe('queued agent (WAITING lease)', () => {
  it('shows the live device screen and who it is queued behind, not a queue placeholder', async () => {
    device({ providerState: 'READY', holder: HOLDER, frame: 'png' });
    const phone: PhoneOverlayModel = {
      ...emptyView('task-a'),
      visible: true,
      snapshot: {
        lease: {
          id: 'lease-a',
          agentId: 'agent-a',
          browserTaskId: 'task-a',
          status: 'WAITING',
          queuePosition: 1,
          queueDeadlineAt: '2026-11-09T20:05:00Z',
          leaseExpiresAt: null,
          controlOwner: 'agent',
          attentionRequestId: null,
          revision: 1,
          holder: { agentId: HOLDER, leaseId: 'lease-x', controlOwner: 'agent', since: '' },
        },
        cursor: 0,
        lastOperation: null,
        pendingOperation: null,
      },
      control: vi.fn(),
      input: vi.fn(),
      invalidateBounds: vi.fn(),
      refreshView: vi.fn(),
    };
    render(<PhoneOverlay phone={phone} readOnly={false} />);
    const region = screen.getByRole('region', { name: 'Cloud iPhone' });
    expect(within(region).getByTestId('phone-queue-status')).toHaveTextContent(
      'Queued behind agent abcdef12 (position 1)',
    );
    expect(within(region).getByRole('link', { name: 'agent abcdef12' })).toHaveAttribute(
      'href',
      `/?agent-id=${HOLDER}`,
    );
    expect(within(region).getByTestId('phone-queue-deadline')).toBeInTheDocument();
    const frame = await within(region).findByTestId('phone-device-frame', {}, { timeout: 4000 });
    expect(frame).toHaveAttribute('alt', 'Cloud iPhone screen');
    expect(region).not.toHaveTextContent('Waiting for the current interaction to finish');
    expect(leaseOrQueueRequests()).toEqual([]);
  });
});
