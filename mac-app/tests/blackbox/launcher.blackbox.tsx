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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { IPC, QuickQueryToggleState, QuickQueryPayload } from '../../shared/types/ipc';
import { MIRRORED_THEME_KEY, mirrorDocumentTheme } from '../../ui/shared/theme-sync';

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
  resizeQuickQuery: ReturnType<typeof vi.fn>;
  setQuickQueryFileDrag: ReturnType<typeof vi.fn>;
}

function installLauncherIpc(
  overrides: {
    submitQuickQuery?: (payload: string | QuickQueryPayload) => Promise<{ success: boolean }>;
    hideQuickQuery?: () => Promise<{ success: boolean }>;
    resizeQuickQuery?: (payload: { height: number }) => Promise<{ success: boolean }>;
    setQuickQueryFileDrag?: (payload: { active: boolean }) => Promise<{ success: boolean }>;
  } = {}
): LauncherIpc {
  const toggleCallbacks: ToggleCallback[] = [];
  const focusCallbacks: FocusCallback[] = [];

  const submitQuickQuery = vi.fn(overrides.submitQuickQuery ?? (async () => ({ success: true })));
  const hideQuickQuery = vi.fn(overrides.hideQuickQuery ?? (async () => ({ success: true })));
  const resizeQuickQuery = vi.fn(overrides.resizeQuickQuery ?? (async () => ({ success: true })));
  const setQuickQueryFileDrag = vi.fn(
    overrides.setQuickQueryFileDrag ?? (async () => ({ success: true }))
  );

  const partial: Partial<IPC> = {
    onQuickQueryToggle: (cb) => {
      toggleCallbacks.push(cb);
    },
    onFocusInput: (cb) => {
      focusCallbacks.push(cb);
    },
    submitQuickQuery,
    hideQuickQuery,
    resizeQuickQuery,
    setQuickQueryFileDrag,
  };

  installIpcMock(partial);

  return {
    toggleCallbacks,
    focusCallbacks,
    submitQuickQuery,
    hideQuickQuery,
    resizeQuickQuery,
    setQuickQueryFileDrag,
  };
}

function makeDropFile(name: string, contents: string, type = 'text/plain'): File {
  return new File([contents], name, { type });
}

function dropFilesOnLauncher(files: File[]): void {
  const target = screen.getByTestId('launcher-drop-target');
  const dataTransfer = {
    files,
    types: ['Files'],
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
  };
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
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

  it('renders the query input, attach button, and submit button on mount (happy-path empty state)', async () => {
    installLauncherIpc();
    const tree = await loadLauncherTree();

    render(<>{tree}</>);

    const input = screen.getByPlaceholderText('Enter any desire');
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe('TEXTAREA');
    expect(input).toHaveValue('');
    expect(input).not.toBeDisabled();
    expect(screen.getByTestId('attach-button')).toBeInTheDocument();
    expect(screen.getByTestId('launcher-file-input')).toBeInTheDocument();
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

  it('shows a drop overlay while dragging files over the launcher', async () => {
    const ipc = installLauncherIpc();
    const tree = await loadLauncherTree();
    render(<>{tree}</>);

    const target = screen.getByTestId('launcher-drop-target');
    expect(screen.queryByTestId('launcher-drag-overlay')).not.toBeInTheDocument();

    fireEvent.dragOver(target, {
      dataTransfer: { types: ['Files'], files: [] },
    });
    expect(screen.getByTestId('launcher-drag-overlay')).toHaveTextContent('Drop files here');
    expect(ipc.setQuickQueryFileDrag).toHaveBeenCalledWith({ active: true });

    fireEvent.dragLeave(target, {
      dataTransfer: { types: ['Files'], files: [] },
    });
    expect(screen.queryByTestId('launcher-drag-overlay')).not.toBeInTheDocument();
    expect(ipc.setQuickQueryFileDrag).toHaveBeenCalledWith({ active: false });
  });

  it('claims macOS screenshot-style drags that omit the Files type on dragover', async () => {
    // Repro: screenshot thumbnail / Finder often advertise text/uri-list (or
    // public.file-url) during dragover and only fill files[] on drop. The old
    // hasFileDrag gate skipped preventDefault → drop fell through to apps behind.
    const ipc = installLauncherIpc();
    const tree = await loadLauncherTree();
    render(<>{tree}</>);

    const target = screen.getByTestId('launcher-drop-target');
    fireEvent.dragOver(target, {
      dataTransfer: { types: ['text/uri-list'], files: [], dropEffect: 'none' },
    });

    expect(screen.getByTestId('launcher-drag-overlay')).toHaveTextContent('Drop files here');
    expect(ipc.setQuickQueryFileDrag).toHaveBeenCalledWith({ active: true });

    const shot = makeDropFile('Screen Shot.png', 'png-bytes', 'image/png');
    fireEvent.drop(target, {
      dataTransfer: {
        types: ['Files', 'text/uri-list'],
        files: [shot],
        items: [{ kind: 'file', type: shot.type, getAsFile: () => shot }],
      },
    });
    expect(await screen.findByTestId('launcher-attachment-chip')).toHaveTextContent(
      'Screen Shot.png'
    );
  });

  it('notifies main of file-drag even when dragover types are empty/unknown', async () => {
    // Repro: macOS screenshot thumbnail can deliver dragover with no advertised
    // types until drop. Main must still cancel blur-hide or the pill vanishes
    // mid-drag while the cursor is already over the launcher.
    const ipc = installLauncherIpc();
    const tree = await loadLauncherTree();
    render(<>{tree}</>);

    const target = screen.getByTestId('launcher-drop-target');
    fireEvent.dragOver(target, {
      dataTransfer: { types: [], files: [], dropEffect: 'none' },
    });

    expect(ipc.setQuickQueryFileDrag).toHaveBeenCalledWith({ active: true });
    // Unknown types: claim the drop for main, but do not show the file overlay.
    expect(screen.queryByTestId('launcher-drag-overlay')).not.toBeInTheDocument();
  });

  it('attaches screenshot drops that only expose File via items.getAsFile', async () => {
    // Repro: files[] empty on drop; only DataTransferItem.getAsFile() returns
    // the Screen Shot.png. Old handler ignored the drop entirely.
    installLauncherIpc();
    const tree = await loadLauncherTree();
    render(<>{tree}</>);

    const shot = makeDropFile('Screen Shot.png', 'png-bytes', 'image/png');
    const target = screen.getByTestId('launcher-drop-target');
    fireEvent.drop(target, {
      dataTransfer: {
        types: ['text/uri-list'],
        files: [],
        items: [{ kind: 'file', type: shot.type, getAsFile: () => shot }],
        getData: () => '',
      },
    });

    expect(await screen.findByTestId('launcher-attachment-chip')).toHaveTextContent(
      'Screen Shot.png'
    );
  });

  it('keeps a hittable window surface so transparent pixels do not pass OS drags through', async () => {
    installLauncherIpc();
    const tree = await loadLauncherTree();
    render(<>{tree}</>);

    const surface = screen.getByTestId('launcher-window-surface');
    expect(surface).toHaveStyle({ backgroundColor: 'rgba(255, 255, 255, 0.01)' });
    expect(surface.className).toContain('no-drag');
  });

  it('holds dropped files as chips and resizes the window', async () => {
    const ipc = installLauncherIpc();
    const tree = await loadLauncherTree();
    render(<>{tree}</>);

    dropFilesOnLauncher([makeDropFile('notes.txt', 'hello')]);

    expect(await screen.findByTestId('launcher-attachments')).toBeInTheDocument();
    expect(screen.getByTestId('launcher-attachment-chip')).toHaveTextContent('notes.txt');
    await waitFor(() => {
      expect(ipc.resizeQuickQuery).toHaveBeenCalledWith(
        expect.objectContaining({ height: expect.any(Number) })
      );
    });
    const heights = ipc.resizeQuickQuery.mock.calls.map(
      (call) => (call[0] as { height: number }).height
    );
    expect(heights.some((h) => h > 100)).toBe(true);
  });

  it('attaches files via the paperclip button file picker', async () => {
    installLauncherIpc();
    const tree = await loadLauncherTree();
    render(<>{tree}</>);

    const fileInput = screen.getByTestId('launcher-file-input') as HTMLInputElement;
    const file = makeDropFile('picked.txt', 'from-picker');
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    expect(await screen.findByTestId('launcher-attachment-chip')).toHaveTextContent('picked.txt');
  });

  it('submits dropped file bytes with the query via submitQuickQuery', async () => {
    const ipc = installLauncherIpc();
    const tree = await loadLauncherTree();
    const user = userEvent.setup();
    render(<>{tree}</>);

    dropFilesOnLauncher([makeDropFile('brief.md', '# plan', 'text/markdown')]);
    await screen.findByTestId('launcher-attachment-chip');

    await user.type(screen.getByPlaceholderText('Enter any desire'), 'summarize this');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(ipc.submitQuickQuery).toHaveBeenCalledTimes(1);
    });
    const payload = ipc.submitQuickQuery.mock.calls[0]?.[0] as QuickQueryPayload;
    expect(payload.query).toBe('summarize this');
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments?.[0]?.name).toBe('brief.md');
    expect(payload.attachments?.[0]?.mimeType).toBe('text/markdown');
    expect(payload.attachments?.[0]?.data.byteLength).toBeGreaterThan(0);
    expect(payload.attachments?.[0]).not.toHaveProperty('autoCaptured');
  });

  it('allows submit with attachments only (no typed query)', async () => {
    const ipc = installLauncherIpc();
    const tree = await loadLauncherTree();
    const user = userEvent.setup();
    render(<>{tree}</>);

    dropFilesOnLauncher([makeDropFile('solo.txt', 'only-file')]);
    await screen.findByTestId('launcher-attachment-chip');

    await user.click(screen.getByTestId('submit-button'));

    await waitFor(() => {
      expect(ipc.submitQuickQuery).toHaveBeenCalledTimes(1);
    });
    const payload = ipc.submitQuickQuery.mock.calls[0]?.[0] as QuickQueryPayload;
    expect(payload.query).toBe('');
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments?.[0]?.name).toBe('solo.txt');
  });

  it('rejects oversized dropped files and keeps the fetch invariant', async () => {
    const ipc = installLauncherIpc();
    const tree = await loadLauncherTree();
    render(<>{tree}</>);

    // Avoid allocating a real 20MB buffer in jsdom — only the size check matters.
    const huge = makeDropFile('huge.bin', 'x', 'application/octet-stream');
    Object.defineProperty(huge, 'size', { value: 20 * 1024 * 1024 + 1 });
    dropFilesOnLauncher([huge]);

    expect(await screen.findByTestId('launcher-attach-error')).toHaveTextContent('20MB');
    expect(screen.queryByTestId('launcher-attachment-chip')).not.toBeInTheDocument();
    expect(ipc.submitQuickQuery).not.toHaveBeenCalled();
    expect(capturedRequests).toHaveLength(0);
  });

  it('clears held attachments when the launcher re-opens', async () => {
    const ipc = installLauncherIpc();
    const tree = await loadLauncherTree();
    render(<>{tree}</>);

    dropFilesOnLauncher([makeDropFile('temp.txt', 'x')]);
    await screen.findByTestId('launcher-attachment-chip');

    const toggle = ipc.toggleCallbacks[0];
    expect(toggle).toBeDefined();
    await act(async () => {
      toggle({ open: true });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('launcher-attachment-chip')).not.toBeInTheDocument();
    });
  });

  it('holds the open-time screenshot in place of earlier files and submits its bytes', async () => {
    const ipc = installLauncherIpc();
    const tree = await loadLauncherTree();
    const user = userEvent.setup();
    render(<>{tree}</>);

    dropFilesOnLauncher([makeDropFile('stale.txt', 'from-last-open')]);
    await screen.findByTestId('launcher-attachment-chip');

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await act(async () => {
      ipc.toggleCallbacks[0]?.({
        open: true,
        screenshot: {
          name: 'Screenshot 2026-10-24 at 15.04.09.png',
          mimeType: 'image/png',
          size: pngBytes.byteLength,
          data: pngBytes.buffer,
          autoCaptured: true,
        },
      });
    });

    const chips = await screen.findAllByTestId('launcher-attachment-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent('Screenshot 2026-10-24 at 15.04.09.png');

    await user.type(screen.getByPlaceholderText('Enter any desire'), 'what is this error');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(ipc.submitQuickQuery).toHaveBeenCalledTimes(1);
    });
    const payload = ipc.submitQuickQuery.mock.calls[0]?.[0] as QuickQueryPayload;
    expect(payload.query).toBe('what is this error');
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments?.[0]?.name).toBe('Screenshot 2026-10-24 at 15.04.09.png');
    expect(payload.attachments?.[0]?.mimeType).toBe('image/png');
    expect(payload.attachments?.[0]?.autoCaptured).toBe(true);
    expect(
      Array.from(new Uint8Array(payload.attachments?.[0]?.data ?? new ArrayBuffer(0)))
    ).toEqual(Array.from(pngBytes));
    expect(capturedRequests).toHaveLength(0);
  });

  it('submits without the screenshot once its chip is removed', async () => {
    const ipc = installLauncherIpc();
    const tree = await loadLauncherTree();
    const user = userEvent.setup();
    render(<>{tree}</>);

    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await act(async () => {
      ipc.toggleCallbacks[0]?.({
        open: true,
        screenshot: {
          name: 'Screenshot.png',
          mimeType: 'image/png',
          size: pngBytes.byteLength,
          data: pngBytes.buffer,
        },
      });
    });
    await screen.findByTestId('launcher-attachment-chip');

    await user.click(screen.getByRole('button', { name: 'Remove Screenshot.png' }));
    expect(screen.queryByTestId('launcher-attachment-chip')).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Enter any desire'), 'no screenshot');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(ipc.submitQuickQuery).toHaveBeenCalledTimes(1);
    });
    const payload = ipc.submitQuickQuery.mock.calls[0]?.[0] as QuickQueryPayload;
    expect(payload.query).toBe('no screenshot');
    expect(payload.attachments).toBeUndefined();
  });

  describe('dark mode (follows the main window theme)', () => {
    afterEach(() => {
      localStorage.removeItem(MIRRORED_THEME_KEY);
      document.documentElement.classList.remove('dark');
      document.head.innerHTML = '';
    });

    it('main window mirrors html.dark into shared storage, and ui/main.tsx installs the mirror', async () => {
      const dispose = mirrorDocumentTheme();
      expect(localStorage.getItem(MIRRORED_THEME_KEY)).toBe('light');
      document.documentElement.classList.add('dark');
      await waitFor(() => expect(localStorage.getItem(MIRRORED_THEME_KEY)).toBe('dark'));
      document.documentElement.classList.remove('dark');
      await waitFor(() => expect(localStorage.getItem(MIRRORED_THEME_KEY)).toBe('light'));
      dispose();

      // Startup before sign-in applies html.dark keeps the last mirrored value.
      localStorage.setItem(MIRRORED_THEME_KEY, 'dark');
      mirrorDocumentTheme()();
      expect(localStorage.getItem(MIRRORED_THEME_KEY)).toBe('dark');

      const mainSource = readFileSync(path.resolve(__dirname, '../../ui/main.tsx'), 'utf8');
      expect(mainSource).toMatch(/^mirrorDocumentTheme\(\);$/m);
    });

    it('launcher window adopts the mirrored dark theme on load and live via storage events', async () => {
      localStorage.setItem(MIRRORED_THEME_KEY, 'dark');
      installLauncherIpc();
      await loadLauncherTree();
      expect(document.documentElement.classList.contains('dark')).toBe(true);

      localStorage.setItem(MIRRORED_THEME_KEY, 'light');
      act(() => {
        window.dispatchEvent(new StorageEvent('storage', { key: MIRRORED_THEME_KEY }));
      });
      expect(document.documentElement.classList.contains('dark')).toBe(false);

      localStorage.setItem(MIRRORED_THEME_KEY, 'dark');
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });

    it('pill, text, chips and send button read the palette vars that html.dark redefines', async () => {
      installLauncherIpc();
      const tree = await loadLauncherTree();
      render(<>{tree}</>);

      const css = Array.from(document.head.querySelectorAll('style'))
        .map((node) => node.textContent ?? '')
        .join('\n');
      const darkBlock = css.slice(css.indexOf('html.dark {'));
      for (const name of [
        '--launcher-fill',
        '--launcher-text',
        '--launcher-muted',
        '--launcher-placeholder',
        '--launcher-chip-bg',
        '--launcher-drop-bg',
        '--launcher-submit-bg',
        '--launcher-submit-icon',
        '--launcher-shadow',
      ]) {
        expect(darkBlock).toContain(`${name}:`);
      }

      const fill = screen.getByTestId('launcher-drop-target');
      expect(fill.style.backgroundColor).toBe('var(--launcher-fill)');
      expect(fill.style.color).toBe('var(--launcher-text)');
      expect(screen.getByPlaceholderText('Enter any desire').style.color).toBe(
        'var(--launcher-text)'
      );
      expect(screen.getByTestId('submit-button').style.background).toBe(
        'var(--launcher-submit-bg)'
      );
      expect(screen.getByTestId('attach-button').style.color).toBe('var(--launcher-muted)');
      expect(screen.getByTestId('liquid-metal-ring')).toBeInTheDocument();
    });
  });
});
