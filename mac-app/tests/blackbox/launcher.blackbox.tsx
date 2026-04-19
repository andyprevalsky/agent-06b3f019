/**
 * Blackbox coverage for the Quick-Query Launcher renderer entry
 * (`mac-app/ui/launcher/main.tsx`).
 *
 * The launcher is a tiny single-page UI that:
 *   - Renders an input on mount and focuses it when
 *     `window.api.onQuickQueryToggle({ open: true })` fires.
 *   - Sends the trimmed query to the main process via
 *     `window.api.submitQuickQuery({ query, submittedAt })` on Enter / click.
 *   - Calls `window.api.hideQuickQuery()` when the user presses Escape.
 *   - Disables the input (and the submit button) while a submit is in flight.
 *
 * Entry files don't export the component — they call `createRoot().render()`
 * at module evaluation. To make this testable without touching production code:
 *   - `react-dom/client.createRoot` is stubbed so `render(tree)` captures the
 *     JSX that main.tsx tried to mount, and the test then hands that captured
 *     tree to `@testing-library/react` directly.
 *   - Heavy renderer deps (shader WebGL wrapper, app-data provider, liquid
 *     button, front-end CSS) are mocked to keep the suite in jsdom.
 *
 * Boundaries (fetch/MSW) are not applicable: the launcher talks only to the
 * Electron main process over the preload IPC bridge (`window.api.*`). We
 * assert `fetchCount === 0` as the fetch-capture invariant.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { capturedRequests, clearCaptures } from './msw/capture';
import { installIpcMock, clearIpcMock } from './ipc-mock';
import type { IPC, QuickQueryToggleState, QuickQueryPayload } from '../../shared/types/ipc';

// --- capture what the entry file tries to render --------------------------
//
// The real entry module ends with:
//   createRoot(document.getElementById('root')!).render(<React.StrictMode>…</React.StrictMode>)
// We replace `createRoot` with a capturing stub so the test owns the render
// lifecycle and can re-render between cases.

let capturedTree: React.ReactNode = null;

vi.mock('react-dom/client', () => ({
  createRoot: () => ({
    render: (tree: React.ReactNode) => {
      capturedTree = tree;
    },
    unmount: () => {
      capturedTree = null;
    },
  }),
}));

// --- heavy renderer-side seams -------------------------------------------
//
// `@paper-design/shaders` is aliased to a stub in vitest.config.ts. The
// remaining seams below replace things we can't resolve transparently:
// - a front-end global CSS import (jsdom has no CSS parser),
// - AppDataProvider (opens a Supabase realtime subscription on mount),
// - LiquidWhiteButton (wraps ShaderMount; replaced with a plain <button> that
//   still exercises the real submit path and exposes a stable testid).

vi.mock('../../ui/index.css', () => ({}));

vi.mock('@/hooks/useAppData', () => ({
  AppDataProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/liquid-white-button', () => ({
  __esModule: true,
  default: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    size?: string;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} data-testid="submit-button">
      {children}
    </button>
  ),
}));

// --- helpers --------------------------------------------------------------

type ToggleCallback = (state: QuickQueryToggleState) => void;
type FocusCallback = () => void;

interface LauncherIpc {
  toggleCallbacks: ToggleCallback[];
  focusCallbacks: FocusCallback[];
  submitQuickQuery: ReturnType<typeof vi.fn>;
  hideQuickQuery: ReturnType<typeof vi.fn>;
}

function installLauncherIpc(
  overrides: {
    submitQuickQuery?: (payload: string | QuickQueryPayload) => Promise<{ success: boolean }>;
    hideQuickQuery?: () => Promise<{ success: boolean }>;
  } = {}
): LauncherIpc {
  const toggleCallbacks: ToggleCallback[] = [];
  const focusCallbacks: FocusCallback[] = [];

  const submitQuickQuery = vi.fn(overrides.submitQuickQuery ?? (async () => ({ success: true })));
  const hideQuickQuery = vi.fn(overrides.hideQuickQuery ?? (async () => ({ success: true })));

  const partial: Partial<IPC> = {
    onQuickQueryToggle: (cb) => {
      toggleCallbacks.push(cb);
    },
    onFocusInput: (cb) => {
      focusCallbacks.push(cb);
    },
    submitQuickQuery,
    hideQuickQuery,
  };

  installIpcMock(partial);

  return { toggleCallbacks, focusCallbacks, submitQuickQuery, hideQuickQuery };
}

async function loadLauncherTree(): Promise<React.ReactNode> {
  // Ensure a #root exists because the entry module grabs it eagerly.
  if (!document.getElementById('root')) {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
  }
  capturedTree = null;
  vi.resetModules();
  await import('../../ui/launcher/main');
  if (capturedTree === null) {
    throw new Error('launcher main.tsx did not call createRoot().render(...)');
  }
  return capturedTree;
}

// --- tests ---------------------------------------------------------------

describe('launcher blackbox', () => {
  beforeEach(() => {
    clearCaptures();
  });

  afterEach(() => {
    clearIpcMock();
    capturedTree = null;
    document.body.innerHTML = '';
  });

  it('renders the query input and submit button on mount (happy-path empty state)', async () => {
    installLauncherIpc();
    const tree = await loadLauncherTree();

    render(<>{tree}</>);

    const input = screen.getByPlaceholderText('Enter any desire');
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue('');
    expect(input).not.toBeDisabled();
    expect(screen.getByTestId('submit-button')).toBeInTheDocument();
  });

  it('submits the trimmed query via window.api.submitQuickQuery on Enter (happy path)', async () => {
    const ipc = installLauncherIpc();
    const tree = await loadLauncherTree();
    const user = userEvent.setup();

    render(<>{tree}</>);

    const input = screen.getByPlaceholderText('Enter any desire') as HTMLInputElement;
    await user.type(input, '  buy milk  ');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(ipc.submitQuickQuery).toHaveBeenCalledTimes(1);
    });
    const payload = ipc.submitQuickQuery.mock.calls[0]?.[0] as QuickQueryPayload;
    expect(payload.query).toBe('buy milk');
    expect(typeof payload.submittedAt).toBe('number');
    expect(payload.submittedAt).toBeGreaterThan(0);

    // Input stays disabled after a successful submit (main hides the window).
    expect(input).toBeDisabled();
  });

  it('submits via clicking the submit button as well', async () => {
    const ipc = installLauncherIpc();
    const tree = await loadLauncherTree();
    const user = userEvent.setup();

    render(<>{tree}</>);

    await user.type(screen.getByPlaceholderText('Enter any desire'), 'draft email');
    await user.click(screen.getByTestId('submit-button'));

    await waitFor(() => {
      expect(ipc.submitQuickQuery).toHaveBeenCalledTimes(1);
    });
    const payload = ipc.submitQuickQuery.mock.calls[0]?.[0] as QuickQueryPayload;
    expect(payload.query).toBe('draft email');
  });

  it('ignores submit when the query is empty or whitespace-only (empty-state guard)', async () => {
    const ipc = installLauncherIpc();
    const tree = await loadLauncherTree();
    const user = userEvent.setup();

    render(<>{tree}</>);

    // No text typed → Enter should be a no-op.
    await user.click(screen.getByPlaceholderText('Enter any desire'));
    await user.keyboard('{Enter}');
    expect(ipc.submitQuickQuery).not.toHaveBeenCalled();

    // Whitespace only → still a no-op because `query.trim()` is falsy.
    await user.type(screen.getByPlaceholderText('Enter any desire'), '    ');
    await user.keyboard('{Enter}');
    expect(ipc.submitQuickQuery).not.toHaveBeenCalled();

    // Clicking the submit button on empty input is also a no-op.
    await user.click(screen.getByTestId('submit-button'));
    expect(ipc.submitQuickQuery).not.toHaveBeenCalled();
  });

  it('re-enables the input when submitQuickQuery rejects (error state)', async () => {
    const ipc = installLauncherIpc({
      submitQuickQuery: async () => {
        throw new Error('main-process offline');
      },
    });
    const tree = await loadLauncherTree();
    const user = userEvent.setup();

    render(<>{tree}</>);

    const input = screen.getByPlaceholderText('Enter any desire') as HTMLInputElement;
    await user.type(input, 'hello');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(ipc.submitQuickQuery).toHaveBeenCalledTimes(1);
    });
    // Input must come back enabled so the user can retry.
    await waitFor(() => {
      expect(input).not.toBeDisabled();
    });
    // Text is still there — we only reset `submitting`, not the query.
    expect(input).toHaveValue('hello');
  });

  it('hides the launcher via window.api.hideQuickQuery when Escape is pressed', async () => {
    const ipc = installLauncherIpc();
    const tree = await loadLauncherTree();

    render(<>{tree}</>);

    // The listener is attached to window, not to the input — fire at window.
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(ipc.hideQuickQuery).toHaveBeenCalledTimes(1);
    });
    expect(ipc.submitQuickQuery).not.toHaveBeenCalled();
  });

  it('clears the query and resets submitting state when the toggle fires with open=true', async () => {
    const ipc = installLauncherIpc({
      // Hold the submit promise open so we can observe the disabled state.
      submitQuickQuery: () => new Promise(() => {}),
    });
    const tree = await loadLauncherTree();
    const user = userEvent.setup();

    render(<>{tree}</>);

    const input = screen.getByPlaceholderText('Enter any desire') as HTMLInputElement;

    await user.type(input, 'stuck in flight');
    await user.keyboard('{Enter}');

    // First submit is pending — input is disabled, query retained.
    await waitFor(() => {
      expect(input).toBeDisabled();
    });
    expect(input).toHaveValue('stuck in flight');

    // Main process re-opens the window: toggle({open:true}) must reset UI.
    const toggle = ipc.toggleCallbacks[0];
    expect(toggle).toBeDefined();
    await act(async () => {
      toggle({ open: true });
    });

    await waitFor(() => {
      expect(input).not.toBeDisabled();
    });
    expect(input).toHaveValue('');
  });

  it('ignores toggle({open:false}) — UI keeps current state', async () => {
    const ipc = installLauncherIpc();
    const tree = await loadLauncherTree();
    const user = userEvent.setup();

    render(<>{tree}</>);

    const input = screen.getByPlaceholderText('Enter any desire') as HTMLInputElement;
    await user.type(input, 'keep me');

    const toggle = ipc.toggleCallbacks[0];
    expect(toggle).toBeDefined();
    await act(async () => {
      toggle({ open: false });
    });

    expect(input).toHaveValue('keep me');
  });

  it('invariant: launcher never calls fetch (no HTTP boundary) — MSW capture stays empty', async () => {
    const ipc = installLauncherIpc();
    const tree = await loadLauncherTree();
    const user = userEvent.setup();

    render(<>{tree}</>);

    await user.type(screen.getByPlaceholderText('Enter any desire'), 'ping');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(ipc.submitQuickQuery).toHaveBeenCalledTimes(1);
    });

    // Strict assertion — the launcher's only boundary is window.api.*, never
    // the network. Any regression that starts calling fetch() would be caught
    // by MSW's `onUnhandledRequest: 'error'`, and here we also assert 0.
    expect(capturedRequests).toHaveLength(0);
  });

  it('registers at least one onQuickQueryToggle and onFocusInput subscriber (contract)', async () => {
    const ipc = installLauncherIpc();
    const tree = await loadLauncherTree();

    render(<>{tree}</>);

    // Observable contract: the launcher wires IPC listeners synchronously on
    // mount so the main process can open + focus it.
    expect(ipc.toggleCallbacks.length).toBeGreaterThanOrEqual(1);
    expect(ipc.focusCallbacks.length).toBeGreaterThanOrEqual(1);
  });
});
