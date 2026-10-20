/**
 * Blackbox tests for the Rose Desktop Phone app wired to /api/phones (L-PHONE):
 *  - GET /api/phones picks the first phone; empty / offline → connect message
 *  - GET /:id polled every 2s only while the Phone is open
 *  - GET /:id/frame?after=<seq> as an authorized fetch → blob URL (old URLs
 *    revoked), at most 2 fps, 204 keeps the current frame, sized to the frame
 *  - holder 'agent' → blurred overlay + View agent + Take control
 *  - holder 'user' → "You're in control", lease renewed every 20s, Release back
 *  - 409 codes → inline text under the button
 *  - closing the Phone stops every request; flag off → no phone requests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { server } from './msw/server';
import { capturedRequests } from './msw/capture';
import { renderWithProviders } from './test-wrapper';

import { RoseAppIcons, RoseAppsProvider } from '@/features/terminal-component-group';
import { isAgentHolder, isUserHolder, type PhoneState } from '@/lib/api/phones';

const API_BASE = 'http://localhost:3001/api';
const PHONE_ID = '0b6a3a43-6f53-4d1c-9a43-6d3f1f0c2a11';
const AGENT_ID = 'agent-nopa-0001';
const AGENT_TITLE = 'Book a table at Nopa';
const CONNECT = 'Connect your iPhone via iPhone Mirroring on your Mac';

// SOI + APP0 "JFIF" + EOI: a minimal fake JPEG body.
const FAKE_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
]);

function mockSession() {
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'test-user', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  localStorage.setItem('app-user', JSON.stringify({ id: 'test-user', is_anonymous: false }));
}

function phoneState(overrides: Partial<PhoneState> = {}): PhoneState {
  return {
    id: PHONE_ID,
    name: "Andy's iPhone",
    model: 'iPhone 16 Pro',
    kind: 'iphone_mirroring',
    macDeviceId: 'mac-device-0001',
    online: true,
    lastSeenAt: '2026-10-20T19:00:00.000Z',
    holder: { kind: null },
    resumeAgent: null,
    frame: { seq: 7, capturedAt: '2026-10-20T19:00:00.000Z', width: 590, height: 1280 },
    ...overrides,
  };
}

const AGENT_HOLDER: PhoneState['holder'] = {
  kind: 'agent',
  agentId: AGENT_ID,
  agentTitle: AGENT_TITLE,
  leaseExpiresAt: '2026-10-20T19:01:00.000Z',
};

interface Backend {
  state: PhoneState | null;
  /** Newest frame seq the Mac has uploaded (null = none yet). */
  frameSeq: number | null;
  takeControlError: { code: string; error: string } | null;
}

/** In-memory /api/phones with the backend's holder semantics. */
function mockPhones(initial: PhoneState | null, frameSeq: number | null = 7): Backend {
  const backend: Backend = { state: initial, frameSeq, takeControlError: null };
  const current = () => {
    if (backend.state === null) throw new Error('no phone');
    return backend.state;
  };
  server.use(
    http.get(`${API_BASE}/phones`, () =>
      HttpResponse.json({ phones: backend.state === null ? [] : [backend.state] }),
    ),
    http.get(`${API_BASE}/phones/:id`, () => HttpResponse.json(current())),
    http.get(`${API_BASE}/phones/:id/frame`, ({ request }) => {
      const after = new URL(request.url).searchParams.get('after');
      const seq = backend.frameSeq;
      if (seq === null || (after !== null && seq <= Number(after))) {
        return new HttpResponse(null, { status: 204 });
      }
      return new HttpResponse(FAKE_JPEG, {
        status: 200,
        headers: {
          'Content-Type': 'image/jpeg',
          'X-Phone-Frame-Seq': String(seq),
          'X-Phone-Frame-Width': '590',
          'X-Phone-Frame-Height': '1280',
        },
      });
    }),
    http.post(`${API_BASE}/phones/:id/take-control`, () => {
      if (backend.takeControlError !== null) {
        return HttpResponse.json(backend.takeControlError, { status: 409 });
      }
      const prev = current();
      const resumeAgent = isAgentHolder(prev.holder)
        ? { agentId: prev.holder.agentId, agentTitle: prev.holder.agentTitle }
        : prev.resumeAgent;
      backend.state = {
        ...prev,
        holder: { kind: 'user', leaseExpiresAt: '2026-10-20T19:02:00.000Z' },
        resumeAgent,
      };
      return HttpResponse.json(backend.state);
    }),
    http.post(`${API_BASE}/phones/:id/release`, () => {
      const prev = current();
      // Control returns to the agent whose control the user took.
      backend.state =
        isUserHolder(prev.holder) && prev.resumeAgent !== null
          ? {
              ...prev,
              holder: {
                kind: 'agent',
                agentId: prev.resumeAgent.agentId,
                agentTitle: prev.resumeAgent.agentTitle,
                leaseExpiresAt: '2026-10-20T19:03:00.000Z',
              },
              resumeAgent: null,
            }
          : { ...prev, holder: { kind: null } };
      return HttpResponse.json(backend.state);
    }),
  );
  return backend;
}

function phoneRequests(path?: RegExp, method = 'GET') {
  return capturedRequests.filter((r) => {
    const { pathname } = new URL(r.url);
    if (!pathname.startsWith('/api/phones')) return false;
    return path === undefined || (path.test(pathname) && r.method === method);
  });
}
const STATE_PATH = new RegExp(`^/api/phones/${PHONE_ID}$`);
const FRAME_PATH = new RegExp(`^/api/phones/${PHONE_ID}/frame$`);
const TAKE_PATH = new RegExp(`^/api/phones/${PHONE_ID}/take-control$`);
const RELEASE_PATH = new RegExp(`^/api/phones/${PHONE_ID}/release$`);

let blobUrls: string[];
let createSpy: ReturnType<typeof vi.spyOn>;
let revokeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockSession();
  blobUrls = [];
  createSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:phone-frame-${blobUrls.length + 1}`;
    blobUrls.push(url);
    return url;
  });
  revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  createSpy.mockRestore();
  revokeSpy.mockRestore();
});

async function openPhone(onSelectAgent?: (agentId: string) => void) {
  const user = userEvent.setup();
  const view = renderWithProviders(
    onSelectAgent === undefined ? (
      <RoseAppIcons />
    ) : (
      <RoseAppsProvider onSelectAgent={onSelectAgent}>
        <RoseAppIcons />
      </RoseAppsProvider>
    ),
  );
  await user.click(screen.getByTestId('rose-app-phone'));
  return { user, view, phone: () => screen.getByTestId('rose-phone') };
}

/** Fake timers cover setInterval only (the Phone's poll/frame/lease cadences). */
const fakeIntervals = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Let in-flight fetches resolve on the real clock. */
async function settle(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/**
 * waitFor's own interval is faked under fakeIntervals(), so request-count
 * checks (which change no DOM) poll here on the real setTimeout clock.
 */
async function eventually(check: () => void, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() - started > timeoutMs) throw err;
    }
    await settle(10);
  }
}

describe('Rose Desktop Phone (/api/phones)', () => {
  it('renders the newest frame as an authorized blob image sized to the frame', async () => {
    mockPhones(phoneState());
    const { phone } = await openPhone();
    const img = await within(phone()).findByTestId('phone-frame');
    expect(img).toHaveAttribute('src', 'blob:phone-frame-1');
    expect(img).toHaveAttribute('width', '590');
    expect(img).toHaveAttribute('height', '1280');
    expect(img.style.aspectRatio).toBe('590 / 1280');
    expect(within(screen.getByTestId('rose-phone-device')).getByTestId('phone-screen')).toContain(
      img,
    );
    const [first] = phoneRequests(FRAME_PATH);
    expect(first.headers.authorization).toBe('Bearer test-token');
    // Idle phone: no overlay, Take control available.
    expect(screen.queryByTestId('phone-agent-overlay')).toBeNull();
    expect(within(phone()).getByRole('button', { name: 'Take control' })).toBeEnabled();
    expect(phoneRequests(/^\/api\/phones$/)).toHaveLength(1);
  });

  it('pulls frames at most twice a second with after=<seq>; 204 keeps the frame, a new one revokes the old URL', async () => {
    fakeIntervals();
    const backend = mockPhones(phoneState());
    const { phone } = await openPhone();
    const img = await within(phone()).findByTestId('phone-frame');
    expect(img).toHaveAttribute('src', 'blob:phone-frame-1');
    expect(phoneRequests(FRAME_PATH)).toHaveLength(1);
    expect(new URL(phoneRequests(FRAME_PATH)[0].url).searchParams.get('after')).toBeNull();

    await advance(499);
    expect(phoneRequests(FRAME_PATH)).toHaveLength(1);
    await advance(1);
    await eventually(() => expect(phoneRequests(FRAME_PATH)).toHaveLength(2));
    await settle();
    expect(new URL(phoneRequests(FRAME_PATH)[1].url).searchParams.get('after')).toBe('7');
    // 204: the current frame stays.
    expect(screen.getByTestId('phone-frame')).toHaveAttribute('src', 'blob:phone-frame-1');
    expect(revokeSpy).not.toHaveBeenCalled();

    backend.frameSeq = 8;
    await advance(500);
    await eventually(() =>
      expect(screen.getByTestId('phone-frame')).toHaveAttribute('src', 'blob:phone-frame-2'),
    );
    expect(revokeSpy).toHaveBeenCalledWith('blob:phone-frame-1');

    // State is polled every 2s while open.
    const polls = phoneRequests(STATE_PATH).length;
    await advance(2000);
    await eventually(() => expect(phoneRequests(STATE_PATH)).toHaveLength(polls + 1));
  });

  it('agent holds the phone: blurred overlay with its title; View agent selects that agent', async () => {
    mockPhones(phoneState({ holder: AGENT_HOLDER }));
    const onSelectAgent = vi.fn();
    const { user, phone } = await openPhone(onSelectAgent);
    const overlay = await within(phone()).findByTestId('phone-agent-overlay');
    expect(overlay.className).toMatch(/backdrop-blur/);
    expect(overlay).toHaveTextContent('Another agent is using this');
    expect(overlay).toHaveTextContent(AGENT_TITLE);
    expect(within(phone()).getByRole('button', { name: 'Take control' })).toBeEnabled();
    await user.click(within(overlay).getByRole('button', { name: 'View agent →' }));
    expect(onSelectAgent).toHaveBeenCalledWith(AGENT_ID);
  });

  it("take control: You're in control and the lease is re-posted every 20s", async () => {
    fakeIntervals();
    mockPhones(phoneState({ holder: AGENT_HOLDER }));
    const { user, phone } = await openPhone();
    await within(phone()).findByTestId('phone-agent-overlay');
    await user.click(within(phone()).getByRole('button', { name: 'Take control' }));

    await within(phone()).findByText("You're in control");
    expect(screen.queryByTestId('phone-agent-overlay')).toBeNull();
    expect(
      within(phone()).getByRole('button', { name: `Release back to ${AGENT_TITLE}` }),
    ).toBeEnabled();
    expect(phoneRequests(TAKE_PATH, 'POST')).toHaveLength(1);

    await advance(19_000);
    expect(phoneRequests(TAKE_PATH, 'POST')).toHaveLength(1);
    await advance(1_000);
    await eventually(() => expect(phoneRequests(TAKE_PATH, 'POST')).toHaveLength(2));
    await settle();
    await advance(20_000);
    await eventually(() => expect(phoneRequests(TAKE_PATH, 'POST')).toHaveLength(3));
    expect(screen.getByText("You're in control")).toBeInTheDocument();
  });

  it('release hands the phone back to the agent and stops renewing', async () => {
    fakeIntervals();
    mockPhones(
      phoneState({
        holder: { kind: 'user', leaseExpiresAt: '2026-10-20T19:02:00.000Z' },
        resumeAgent: { agentId: AGENT_ID, agentTitle: AGENT_TITLE },
      }),
    );
    const { user, phone } = await openPhone();
    await user.click(
      await within(phone()).findByRole('button', { name: `Release back to ${AGENT_TITLE}` }),
    );
    await eventually(() => expect(phoneRequests(RELEASE_PATH, 'POST')).toHaveLength(1));
    const overlay = await within(phone()).findByTestId('phone-agent-overlay');
    expect(overlay).toHaveTextContent(AGENT_TITLE);
    expect(screen.queryByText("You're in control")).toBeNull();
    expect(within(phone()).getByRole('button', { name: 'Take control' })).toBeEnabled();

    await advance(60_000);
    await settle();
    expect(phoneRequests(TAKE_PATH, 'POST')).toHaveLength(0);
  });

  it('offline phone shows the connect message and pulls no frames', async () => {
    mockPhones(phoneState({ online: false, frame: null }));
    const { phone } = await openPhone();
    expect(await within(phone()).findByText(CONNECT)).toBeInTheDocument();
    expect(within(phone()).getByRole('button', { name: 'Take control' })).toBeDisabled();
    expect(screen.queryByTestId('phone-frame')).toBeNull();
    expect(phoneRequests(FRAME_PATH)).toHaveLength(0);
  });

  it('no phones: the connect message and no per-phone requests', async () => {
    mockPhones(null);
    const { phone } = await openPhone();
    expect(await within(phone()).findByText(CONNECT)).toBeInTheDocument();
    expect(within(phone()).getByRole('button', { name: 'Take control' })).toBeDisabled();
    expect(phoneRequests()).toHaveLength(1);
  });

  it.each([
    ['PHONE_IN_USE_BY_USER', 'You are already controlling this iPhone in another window.'],
    ['PHONE_IN_USE_BY_AGENT', 'Another agent is using this iPhone. Try again when it finishes.'],
    ['PHONE_LEASE_LOST', 'Your control of this iPhone lapsed. Take control again.'],
    ['PHONE_OFFLINE', CONNECT],
  ])('409 %s shows clear inline text under the button', async (code, text) => {
    const backend = mockPhones(phoneState({ holder: AGENT_HOLDER }));
    backend.takeControlError = { code, error: `server says ${code}` };
    const { user, phone } = await openPhone();
    await within(phone()).findByTestId('phone-agent-overlay');
    const button = within(phone()).getByRole('button', { name: 'Take control' });
    await user.click(button);
    const alert = await within(phone()).findByRole('alert');
    expect(alert).toHaveTextContent(text);
    expect(button.nextElementSibling).toBe(alert);
    expect(screen.queryByText("You're in control")).toBeNull();
  });

  it('closing the Phone stops every request and revokes the frame URL', async () => {
    fakeIntervals();
    mockPhones(
      phoneState({
        holder: { kind: 'user', leaseExpiresAt: '2026-10-20T19:02:00.000Z' },
        resumeAgent: { agentId: AGENT_ID, agentTitle: AGENT_TITLE },
      }),
    );
    const { user, phone } = await openPhone();
    await within(phone()).findByTestId('phone-frame');
    await within(phone()).findByText("You're in control");

    await user.click(screen.getByTestId('rose-app-phone'));
    expect(screen.queryByTestId('rose-phone')).toBeNull();
    expect(revokeSpy).toHaveBeenCalledWith('blob:phone-frame-1');
    const before = phoneRequests().length;
    await advance(120_000);
    await settle();
    expect(phoneRequests()).toHaveLength(before);
  });

  it('unmounting the open Phone stops polling and revokes the frame URL', async () => {
    fakeIntervals();
    mockPhones(phoneState());
    const { view, phone } = await openPhone();
    await within(phone()).findByTestId('phone-frame');
    view.unmount();
    expect(revokeSpy).toHaveBeenCalledWith('blob:phone-frame-1');
    const before = phoneRequests().length;
    await advance(60_000);
    await settle();
    expect(phoneRequests()).toHaveLength(before);
  });
});

describe('Phone behind the Rose Desktop flag', () => {
  it('flag off: opening the Phone makes no phone requests and renders nothing', async () => {
    mockPhones(phoneState());
    const user = userEvent.setup();
    // Even if something opens the Phone app, the flag-off account gets no device
    // and no /api/phones traffic (the real layout does not mount the icons).
    renderWithProviders(<RoseAppIcons />, { roseDesktop: false });
    await user.click(screen.getByTestId('rose-app-phone'));
    await settle(50);
    expect(screen.queryByTestId('rose-phone')).toBeNull();
    expect(phoneRequests()).toHaveLength(0);
  });
});
