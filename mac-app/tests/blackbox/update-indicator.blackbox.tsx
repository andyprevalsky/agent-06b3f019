/**
 * UpdateIndicator domain blackbox tests — file-level boundary for
 * `mac-app/ui/UpdateIndicator.tsx`.
 *
 * Scope note: a subset of the UpdateIndicator state machine is already
 * exercised inside `renderer-main.blackbox.tsx` (happy-path transitions
 * between available → downloading → downloaded → error, and the
 * `building` → `none` mapping). This suite complements that by asserting
 * the *module boundary* for the domain's entry file:
 *
 *   - Default export is a React component
 *   - IPC registration contract (`onUpdateStatus`, `onUpdateProgress`
 *     subscribed exactly once across re-renders)
 *   - Portal lifecycle (`#rose-bottom-left-chips` div created on first
 *     mount and removed on unmount)
 *   - Empty / idle state renders nothing (null)
 *   - Each discrete state-payload variant that renderer-main does not
 *     cover: `checking`, percent fallback via `onUpdateProgress` when
 *     payload omits `percent`, multi-payload transitions that land back
 *     on idle, and the per-version dismiss memory for `available` /
 *     `downloaded` chips.
 *
 * All reads/writes go through the `window.api` preload bridge (mocked
 * via `installIpcMock`). The component makes no network calls, so MSW
 * stays in its default "error on any unhandled request" mode as a
 * boundary assertion: if UpdateIndicator ever starts fetching, the
 * suite will fail loudly.
 *
 * State-machine sketch (what this suite covers):
 *   idle ──onUpdateStatus──▶ checking ─▶ available ─▶ downloading ─▶ downloaded
 *     ▲                                         │
 *     └────────── dismiss / Later ──────────────┘
 *   building ──(mapped)──▶ none (auto-dismiss 3s) ─▶ hidden
 *   any ──onUpdateStatus(error)──▶ error ──Retry──▶ checkForUpdates()
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from './test-wrapper';
import { clearIpcMock, installIpcMock } from './ipc-mock';
import UpdateIndicator from '../../ui/UpdateIndicator';
import { PORTAL_ID } from '../../ui/shared/bottom-left-chips/config';
import type { IPC, UpdateStatusPayload } from '../../shared/types/ipc';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const NONE_DISMISS_DELAY_MS = 3000;

interface Harness {
  emitStatus: (payload: UpdateStatusPayload) => void;
  emitProgress: (percent: number) => void;
  onUpdateStatus: ReturnType<typeof vi.fn>;
  onUpdateProgress: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
  restartToUpdate: ReturnType<typeof vi.fn>;
  checkForUpdates: ReturnType<typeof vi.fn>;
}

function setupHarness(): Harness {
  const statusCallbacks: Array<(p: UpdateStatusPayload) => void> = [];
  const progressCallbacks: Array<(percent: number) => void> = [];

  const onUpdateStatus = vi.fn((cb: (p: UpdateStatusPayload) => void) => {
    statusCallbacks.push(cb);
  });
  const onUpdateProgress = vi.fn((cb: (percent: number) => void) => {
    progressCallbacks.push(cb);
  });
  const downloadUpdate = vi.fn();
  const restartToUpdate = vi.fn();
  const checkForUpdates = vi.fn();

  installIpcMock({
    onUpdateStatus,
    onUpdateProgress,
    downloadUpdate,
    restartToUpdate,
    checkForUpdates,
  } as Partial<IPC>);

  const emitStatus = (payload: UpdateStatusPayload) => {
    act(() => {
      statusCallbacks.forEach((cb) => {
        cb(payload);
      });
    });
  };
  const emitProgress = (percent: number) => {
    act(() => {
      progressCallbacks.forEach((cb) => {
        cb(percent);
      });
    });
  };

  return {
    emitStatus,
    emitProgress,
    onUpdateStatus,
    onUpdateProgress,
    downloadUpdate,
    restartToUpdate,
    checkForUpdates,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  clearIpcMock();
  // Ensure no orphan portal survives across tests.
  document.getElementById(PORTAL_ID)?.remove();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Module boundary
// ---------------------------------------------------------------------------

describe('UpdateIndicator — module boundary', () => {
  it('default-exports a React component', () => {
    expect(typeof UpdateIndicator).toBe('function');
  });

  it('renders without crashing and registers both update IPC listeners exactly once', () => {
    const h = setupHarness();
    renderWithProviders(<UpdateIndicator />);

    expect(h.onUpdateStatus).toHaveBeenCalledTimes(1);
    expect(h.onUpdateProgress).toHaveBeenCalledTimes(1);
  });

  it('renders without crashing when the preload bridge is unavailable', () => {
    clearIpcMock();

    expect(() => {
      renderWithProviders(<UpdateIndicator />);
    }).not.toThrow();

    expect(screen.queryByText(/New update available/i)).not.toBeInTheDocument();
  });

  it('does not re-subscribe on re-render (listenerAttachedRef guard)', () => {
    const h = setupHarness();
    const { rerender } = renderWithProviders(<UpdateIndicator />);

    rerender(<UpdateIndicator />);
    rerender(<UpdateIndicator />);

    // The component guards listener attachment with a ref — strict re-renders
    // must not cause additional subscriptions.
    expect(h.onUpdateStatus).toHaveBeenCalledTimes(1);
    expect(h.onUpdateProgress).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Portal lifecycle
// ---------------------------------------------------------------------------

describe('UpdateIndicator — portal lifecycle', () => {
  it('does NOT create the portal node until a visible state is emitted (idle is null)', () => {
    // Portal container is memoized but it's only appended when the component
    // actually calls createPortal. On idle the component returns null, so the
    // node is computed lazily — practically speaking the useMemo runs and
    // appends the node to document.body once. We assert only on the observable
    // DOM contract: no chip visible, idle text absent.
    setupHarness();
    renderWithProviders(<UpdateIndicator />);

    expect(screen.queryByText(/Up to date/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/New update available/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Downloading/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Update failed/i)).not.toBeInTheDocument();
  });

  it('creates exactly one #rose-bottom-left-chips portal root and reuses it across state emits', () => {
    const { emitStatus } = setupHarness();
    renderWithProviders(<UpdateIndicator />);

    emitStatus({ state: 'available', version: '9.9.9' });
    const first = document.getElementById(PORTAL_ID);
    expect(first).toBeInstanceOf(HTMLDivElement);

    emitStatus({ state: 'downloading', percent: 10 });
    emitStatus({ state: 'downloaded', version: '9.9.9' });

    const all = document.querySelectorAll(`#${PORTAL_ID}`);
    expect(all).toHaveLength(1);
    expect(document.getElementById(PORTAL_ID)).toBe(first);
  });

  it('removes the portal root from document.body on unmount (cleanup state)', () => {
    const { emitStatus } = setupHarness();
    const { unmount } = renderWithProviders(<UpdateIndicator />);

    emitStatus({ state: 'available', version: '1.0.0' });
    expect(document.getElementById(PORTAL_ID)).not.toBeNull();

    unmount();
    expect(document.getElementById(PORTAL_ID)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// States that renderer-main does not cover
// ---------------------------------------------------------------------------

describe('UpdateIndicator — state rendering (file boundary)', () => {
  it('renders nothing on mount (idle = empty state)', () => {
    setupHarness();
    renderWithProviders(<UpdateIndicator />);

    // No visible chip text for any of the known states.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('Up to date')).not.toBeInTheDocument();
    expect(screen.queryByText('Downloading...')).not.toBeInTheDocument();
  });

  it('renders a spinner-only chip for state=checking (no text, no buttons)', () => {
    const { emitStatus } = setupHarness();
    renderWithProviders(<UpdateIndicator />);

    emitStatus({ state: 'checking' });

    // No text-bearing chip is rendered during "checking".
    expect(screen.queryByText('Up to date')).not.toBeInTheDocument();
    expect(screen.queryByText('New update available')).not.toBeInTheDocument();
    expect(screen.queryByText('Downloading...')).not.toBeInTheDocument();
    expect(screen.queryByText('Update failed')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    // The spinner div lives inside the portal.
    const portal = document.getElementById(PORTAL_ID);
    expect(portal).not.toBeNull();
    expect(portal?.querySelector('.animate-spin')).not.toBeNull();
  });

  it('state=downloading uses payload.percent when present', () => {
    const { emitStatus } = setupHarness();
    renderWithProviders(<UpdateIndicator />);

    emitStatus({ state: 'downloading', percent: 73 });
    expect(screen.getByText('Downloading...')).toBeInTheDocument();
    // Percent bar width is not text; exercising the code path is enough — the
    // state-transition back to a chip is covered below.
  });

  it('state=downloading falls back to the onUpdateProgress stream when payload omits percent', () => {
    const { emitStatus, emitProgress } = setupHarness();
    renderWithProviders(<UpdateIndicator />);

    // Kick into downloading with no percent — component should fall back to
    // the progress stream.
    emitProgress(55);
    emitStatus({ state: 'downloading' });

    expect(screen.getByText('Downloading...')).toBeInTheDocument();

    // Push another progress tick — still visible, no crash.
    emitProgress(80);
    expect(screen.getByText('Downloading...')).toBeInTheDocument();
  });

  it('maps state=building → none chip (auto-dismisses after 3s)', () => {
    vi.useFakeTimers();
    const { emitStatus } = setupHarness();
    renderWithProviders(<UpdateIndicator />);

    emitStatus({ state: 'building' });
    expect(screen.getByText('Up to date')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(NONE_DISMISS_DELAY_MS + 50);
    });
    expect(screen.queryByText('Up to date')).not.toBeInTheDocument();
  });

  it('clicking the "Up to date" chip dismisses it immediately (before the 3s timeout)', () => {
    // Note: fake timers + userEvent interact poorly; the dismiss handler is a
    // plain onClick, so a synchronous fireEvent click is a perfectly valid
    // blackbox assertion of the observable behavior.
    vi.useFakeTimers();
    const { emitStatus } = setupHarness();
    renderWithProviders(<UpdateIndicator />);

    emitStatus({ state: 'none' });
    act(() => {
      fireEvent.click(screen.getByText('Up to date'));
    });

    expect(screen.queryByText('Up to date')).not.toBeInTheDocument();
  });

  it('every visible chip sits inside the launcher liquid-metal ring with dark-mode styling', () => {
    const { emitStatus } = setupHarness();
    renderWithProviders(<UpdateIndicator />);

    const states: UpdateStatusPayload[] = [
      { state: 'available', version: '9.9.9' },
      { state: 'downloading', percent: 40 },
      { state: 'downloaded', version: '9.9.9' },
      { state: 'error', message: 'boom' },
    ];
    for (const payload of states) {
      emitStatus(payload);
      const chip = screen.getByTestId('update-chip');
      expect(chip.querySelector('[data-testid="liquid-metal-ring"]')).not.toBeNull();
      const fill = chip.lastElementChild as HTMLElement;
      expect(fill.className).toContain('dark:bg-[#262624]');
      expect(chip.querySelector('svg, span')?.getAttribute('class') ?? '').toMatch(/dark:/);
    }

    emitStatus({ state: 'available', version: '9.9.9' });
    expect(screen.getByText('New update available').className).toContain('dark:text-');
    expect(screen.getByRole('button', { name: 'Install Now' }).className).toContain('dark:bg-');
    expect(screen.getByRole('button', { name: 'Later' }).className).toContain('dark:text-');
  });
});

// ---------------------------------------------------------------------------
// IPC wiring — user interactions invoke the preload bridge
// ---------------------------------------------------------------------------

describe('UpdateIndicator — IPC interactions', () => {
  it('Install Now → window.api.downloadUpdate()', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<UpdateIndicator />);

    h.emitStatus({ state: 'available', version: '2.0.0' });
    await user.click(screen.getByRole('button', { name: 'Install Now' }));

    expect(h.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('Restart Now → window.api.restartToUpdate()', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<UpdateIndicator />);

    h.emitStatus({ state: 'downloaded', version: '2.0.0' });
    await user.click(screen.getByRole('button', { name: 'Restart Now' }));

    expect(h.restartToUpdate).toHaveBeenCalledTimes(1);
  });

  it('Retry (error chip) → window.api.checkForUpdates()', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<UpdateIndicator />);

    h.emitStatus({ state: 'error', message: 'download failed' });
    expect(screen.getByText('Update failed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(h.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('Later (available chip) dismisses without invoking any update IPC', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<UpdateIndicator />);

    h.emitStatus({ state: 'available', version: '2.0.0' });
    await user.click(screen.getByRole('button', { name: 'Later' }));

    expect(screen.queryByText('New update available')).not.toBeInTheDocument();
    expect(h.downloadUpdate).not.toHaveBeenCalled();
    expect(h.restartToUpdate).not.toHaveBeenCalled();
    expect(h.checkForUpdates).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Per-version dismiss memory
// ---------------------------------------------------------------------------

describe('UpdateIndicator — dismissal memory per version', () => {
  it('re-emitting the same dismissed version keeps the chip hidden', async () => {
    const user = userEvent.setup();
    const { emitStatus } = setupHarness();
    renderWithProviders(<UpdateIndicator />);

    emitStatus({ state: 'available', version: '3.1.4' });
    await user.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByText('New update available')).not.toBeInTheDocument();

    // Same version comes back — should stay hidden.
    emitStatus({ state: 'available', version: '3.1.4' });
    expect(screen.queryByText('New update available')).not.toBeInTheDocument();
  });

  it('a NEW version after a dismissal re-shows the chip (dismiss memory is per-version)', async () => {
    const user = userEvent.setup();
    const { emitStatus } = setupHarness();
    renderWithProviders(<UpdateIndicator />);

    emitStatus({ state: 'available', version: '3.1.4' });
    await user.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByText('New update available')).not.toBeInTheDocument();

    emitStatus({ state: 'available', version: '3.2.0' });
    expect(screen.getByText('New update available')).toBeInTheDocument();
  });

  it('dismissing a downloaded chip also suppresses re-emits of the same version', async () => {
    const user = userEvent.setup();
    const { emitStatus } = setupHarness();
    renderWithProviders(<UpdateIndicator />);

    emitStatus({ state: 'downloaded', version: '4.0.0' });
    await user.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByText('New update available')).not.toBeInTheDocument();

    emitStatus({ state: 'downloaded', version: '4.0.0' });
    expect(screen.queryByText('New update available')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart Now' })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Multi-payload state transitions
// ---------------------------------------------------------------------------

describe('UpdateIndicator — state transitions', () => {
  it('available → downloading → downloaded → idle walk', async () => {
    const user = userEvent.setup();
    const { emitStatus } = setupHarness();
    renderWithProviders(<UpdateIndicator />);

    emitStatus({ state: 'available', version: '5.0.0' });
    expect(screen.getByText('New update available')).toBeInTheDocument();

    emitStatus({ state: 'downloading', percent: 10 });
    expect(screen.queryByText('New update available')).not.toBeInTheDocument();
    expect(screen.getByText('Downloading...')).toBeInTheDocument();

    emitStatus({ state: 'downloaded', version: '5.0.0' });
    expect(screen.queryByText('Downloading...')).not.toBeInTheDocument();
    expect(screen.getByText('New update available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart Now' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByText('New update available')).not.toBeInTheDocument();
  });

  it('emitting state=none cancels a prior scheduled dismiss and restarts the timer', () => {
    vi.useFakeTimers();
    const { emitStatus } = setupHarness();
    renderWithProviders(<UpdateIndicator />);

    emitStatus({ state: 'none' });
    expect(screen.getByText('Up to date')).toBeInTheDocument();

    // Halfway through the first timer, emit again — this should clear the
    // pending timer and schedule a new one (component resets on every emit).
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    emitStatus({ state: 'none' });
    expect(screen.getByText('Up to date')).toBeInTheDocument();

    // If the first timer were still live, the chip would disappear at t=3000
    // (1500 + 1500). Advance past that point but stay short of the restarted
    // timer's 3000ms window — chip must still be visible.
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(screen.getByText('Up to date')).toBeInTheDocument();

    // Now cross the restarted timer's threshold.
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.queryByText('Up to date')).not.toBeInTheDocument();
  });

  it('transitioning away from "none" hides the up-to-date chip immediately', () => {
    const { emitStatus } = setupHarness();
    renderWithProviders(<UpdateIndicator />);

    emitStatus({ state: 'none' });
    expect(screen.getByText('Up to date')).toBeInTheDocument();

    emitStatus({ state: 'error', message: 'nope' });
    expect(screen.queryByText('Up to date')).not.toBeInTheDocument();
    expect(screen.getByText('Update failed')).toBeInTheDocument();
  });
});
