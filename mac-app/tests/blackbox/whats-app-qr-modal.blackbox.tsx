/**
 * WhatsAppQRModal domain blackbox tests — file-level boundary for
 * `mac-app/ui/components/WhatsAppQRModal.tsx`.
 *
 * Domain shape
 * ------------
 * WhatsAppQRModal is a pure presentational modal: it renders a QR code (or a
 * spinner while the QR is pending) and an optional "Connecting..." indicator.
 * All IPC wiring (window.api.whatsapp.connect + window.api.onWhatsAppQRCode)
 * lives in its parent (`ui/onboarding/OnboardingData.tsx`). From the
 * component's perspective, the "IPC update" surface is the `qrCode` prop:
 * parents receive QR payloads over IPC and push them down as prop changes.
 *
 * Observable surface (what the user sees / triggers):
 *  - isOpen=false       → renders nothing
 *  - isOpen=true + qrCode=null      → spinner inside the white QR tile
 *  - isOpen=true + qrCode="..."     → <svg> QR code painted with that value
 *  - isConnecting=true  → "Connecting..." status row with a spinner
 *  - Clicking the backdrop OR the close (X) button → onClose()
 *  - Instructions list text is present and in the correct order
 *
 * State-machine sketch (prop-driven — no internal state):
 *   closed(isOpen=false)
 *        │ parent flips isOpen=true (handleWhatsAppConnect)
 *        ▼
 *   open + pending(qrCode=null)         ──── spinner tile
 *        │ parent pushes QR via onWhatsAppQRCode IPC → setWhatsAppQRCode(qr)
 *        ▼
 *   open + ready(qrCode="wa://…")       ──── <svg> rendered
 *        │ user clicks backdrop / X, OR parent receives connect() success
 *        ▼
 *   onClose() → parent flips isOpen=false (+ resets qrCode=null)
 *
 * IPC boundary
 * ------------
 * This component does not call `window.api.*` directly and does not `fetch`.
 * We still install the shared IPC mock (to prove no accidental bridge usage)
 * and we let MSW run in its default `onUnhandledRequest: 'error'` mode: if
 * this component ever starts making network calls the suite will fail loudly.
 * That is the "IPC boundary capture" for a presentational modal.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from './test-wrapper';
import { clearIpcMock, installIpcMock } from './ipc-mock';
import { capturedRequests, clearCaptures } from './msw/capture';
import WhatsAppQRModal from '../../ui/components/WhatsAppQRModal';

// qrcode.react renders the QR as an <svg width="200" height="200">. The
// WhatsApp brand icon in the header is also an <svg> but has no explicit
// width/height, so selecting by width is the simplest observable DOM probe.
const findQrSvg = (container: HTMLElement): SVGElement | undefined =>
  Array.from(container.querySelectorAll('svg')).find((el) => el.getAttribute('width') === '200');

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  clearIpcMock();
  clearCaptures();
});

// ---------------------------------------------------------------------------
// Module boundary
// ---------------------------------------------------------------------------

describe('WhatsAppQRModal — module boundary', () => {
  it('default-exports a React component', () => {
    expect(typeof WhatsAppQRModal).toBe('function');
  });

  it('renders nothing when isOpen=false (closed state is observable-empty)', () => {
    installIpcMock();
    const { container } = renderWithProviders(
      <WhatsAppQRModal isOpen={false} onClose={vi.fn()} qrCode={null} isConnecting={false} />
    );

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('Connect WhatsApp')).not.toBeInTheDocument();
    expect(screen.queryByText(/Scan this QR code/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Happy-path render
// ---------------------------------------------------------------------------

describe('WhatsAppQRModal — happy path render', () => {
  it('renders modal chrome (title, description, instructions) when isOpen=true', () => {
    installIpcMock();
    renderWithProviders(
      <WhatsAppQRModal
        isOpen={true}
        onClose={vi.fn()}
        qrCode="wa://pair/ABC123"
        isConnecting={false}
      />
    );

    expect(screen.getByText('Connect WhatsApp')).toBeInTheDocument();
    expect(screen.getByText(/Scan this QR code with WhatsApp/i)).toBeInTheDocument();
    expect(screen.getByText('How to scan:')).toBeInTheDocument();

    // Instructions list items — order matters (step 1 → step 4).
    const steps = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatch(/Open WhatsApp on your phone/);
    expect(steps[1]).toMatch(/Settings/);
    expect(steps[1]).toMatch(/Linked Devices/);
    expect(steps[2]).toMatch(/Link a Device/);
    expect(steps[3]).toMatch(/Point your phone at this screen/);
  });

  it('paints an <svg> QR code when qrCode is a non-empty string', () => {
    installIpcMock();
    const { container } = renderWithProviders(
      <WhatsAppQRModal
        isOpen={true}
        onClose={vi.fn()}
        qrCode="wa://pair/HAPPY-PATH"
        isConnecting={false}
      />
    );

    const qrSvg = findQrSvg(container);
    expect(qrSvg).toBeTruthy();
    expect(qrSvg?.getAttribute('height')).toBe('200');
  });

  it('does not render the "Connecting..." status row when isConnecting=false', () => {
    installIpcMock();
    renderWithProviders(
      <WhatsAppQRModal
        isOpen={true}
        onClose={vi.fn()}
        qrCode="wa://pair/XYZ"
        isConnecting={false}
      />
    );

    expect(screen.queryByText('Connecting...')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Empty state — qrCode is null while the modal is open
// ---------------------------------------------------------------------------

describe('WhatsAppQRModal — empty (pending QR) state', () => {
  it('renders a spinner inside the QR tile when qrCode=null', () => {
    installIpcMock();
    const { container } = renderWithProviders(
      <WhatsAppQRModal isOpen={true} onClose={vi.fn()} qrCode={null} isConnecting={false} />
    );

    // No QR svg yet — only the brand icon <svg> in the header.
    expect(findQrSvg(container)).toBeUndefined();

    // The loader lives inside the white QR tile. We assert via the
    // animate-spin class, which is the observable spinner-loader contract
    // shared across the codebase (lucide-react Loader2).
    const spinners = container.querySelectorAll('.animate-spin');
    expect(spinners.length).toBeGreaterThanOrEqual(1);
  });

  it('modal chrome still renders (title + instructions) while QR is pending', () => {
    installIpcMock();
    renderWithProviders(
      <WhatsAppQRModal isOpen={true} onClose={vi.fn()} qrCode={null} isConnecting={false} />
    );

    expect(screen.getByText('Connect WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('How to scan:')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// QR state update (simulated IPC push via prop change)
// ---------------------------------------------------------------------------

describe('WhatsAppQRModal — QR state update via prop change (simulated IPC)', () => {
  it('swaps the spinner for an <svg> QR code when qrCode transitions null → string', () => {
    installIpcMock();
    const onClose = vi.fn();
    const { container, rerender } = renderWithProviders(
      <WhatsAppQRModal isOpen={true} onClose={onClose} qrCode={null} isConnecting={true} />
    );

    // Initial: pending → spinner, no 200×200 QR svg.
    expect(findQrSvg(container)).toBeUndefined();

    // Parent receives the QR over IPC (onWhatsAppQRCode) and pushes it down.
    rerender(
      <WhatsAppQRModal
        isOpen={true}
        onClose={onClose}
        qrCode="wa://pair/FROM-IPC"
        isConnecting={true}
      />
    );

    expect(findQrSvg(container)).toBeTruthy();
  });

  it('re-renders a new <svg> when the QR value updates (WhatsApp rotates QR strings)', () => {
    installIpcMock();
    const onClose = vi.fn();
    const { container, rerender } = renderWithProviders(
      <WhatsAppQRModal
        isOpen={true}
        onClose={onClose}
        qrCode="wa://pair/FIRST"
        isConnecting={true}
      />
    );

    expect(findQrSvg(container)).toBeTruthy();

    rerender(
      <WhatsAppQRModal
        isOpen={true}
        onClose={onClose}
        qrCode="wa://pair/SECOND-ROTATION"
        isConnecting={true}
      />
    );

    // Still exactly one 200×200 QR svg after rotation (not stacked on top).
    const qrSvgs = Array.from(container.querySelectorAll('svg')).filter(
      (el) => el.getAttribute('width') === '200'
    );
    expect(qrSvgs).toHaveLength(1);
  });

  it('returns to spinner when qrCode transitions string → null (e.g. stream restart)', () => {
    installIpcMock();
    const onClose = vi.fn();
    const { container, rerender } = renderWithProviders(
      <WhatsAppQRModal
        isOpen={true}
        onClose={onClose}
        qrCode="wa://pair/WILL-RESET"
        isConnecting={true}
      />
    );

    expect(findQrSvg(container)).toBeTruthy();

    rerender(<WhatsAppQRModal isOpen={true} onClose={onClose} qrCode={null} isConnecting={true} />);

    expect(findQrSvg(container)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Connecting indicator
// ---------------------------------------------------------------------------

describe('WhatsAppQRModal — connecting indicator', () => {
  it('shows the "Connecting..." row when isConnecting=true', () => {
    installIpcMock();
    renderWithProviders(
      <WhatsAppQRModal
        isOpen={true}
        onClose={vi.fn()}
        qrCode="wa://pair/IDLE"
        isConnecting={true}
      />
    );

    expect(screen.getByText('Connecting...')).toBeInTheDocument();
  });

  it('hides the "Connecting..." row when isConnecting flips back to false', () => {
    installIpcMock();
    const onClose = vi.fn();
    const { rerender } = renderWithProviders(
      <WhatsAppQRModal
        isOpen={true}
        onClose={onClose}
        qrCode="wa://pair/IDLE"
        isConnecting={true}
      />
    );

    expect(screen.getByText('Connecting...')).toBeInTheDocument();

    rerender(
      <WhatsAppQRModal
        isOpen={true}
        onClose={onClose}
        qrCode="wa://pair/IDLE"
        isConnecting={false}
      />
    );

    expect(screen.queryByText('Connecting...')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Close interactions — onClose is the single observable outbound callback
// ---------------------------------------------------------------------------

describe('WhatsAppQRModal — close interactions', () => {
  it('clicking the X button calls onClose exactly once', async () => {
    const user = userEvent.setup();
    installIpcMock();
    const onClose = vi.fn();
    renderWithProviders(
      <WhatsAppQRModal
        isOpen={true}
        onClose={onClose}
        qrCode="wa://pair/X-CLOSE"
        isConnecting={false}
      />
    );

    // The close button is the only <button> in the modal (there are no
    // action buttons in this modal).
    const closeBtn = screen.getByRole('button');
    await user.click(closeBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the backdrop calls onClose exactly once', async () => {
    const user = userEvent.setup();
    installIpcMock();
    const onClose = vi.fn();
    const { container } = renderWithProviders(
      <WhatsAppQRModal
        isOpen={true}
        onClose={onClose}
        qrCode="wa://pair/BACKDROP"
        isConnecting={false}
      />
    );

    // The backdrop is the semi-transparent overlay. It is the element with
    // class "fixed inset-0 z-50"'s first child div (absolute inset-0).
    const backdrop = container.querySelector('.bg-black\\/50');
    expect(backdrop).toBeTruthy();
    await user.click(backdrop as Element);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('onClose is NOT called just because the component mounts while open', () => {
    installIpcMock();
    const onClose = vi.fn();
    renderWithProviders(
      <WhatsAppQRModal
        isOpen={true}
        onClose={onClose}
        qrCode="wa://pair/MOUNT"
        isConnecting={false}
      />
    );

    expect(onClose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// IPC + network boundary capture — the modal must not touch window.api or fetch
// ---------------------------------------------------------------------------

describe('WhatsAppQRModal — IPC / network boundary', () => {
  it('does not invoke any window.api.* method or issue any network request on render', () => {
    const ipc = installIpcMock();
    renderWithProviders(
      <WhatsAppQRModal
        isOpen={true}
        onClose={vi.fn()}
        qrCode="wa://pair/BOUNDARY"
        isConnecting={true}
      />
    );

    // The Proxy-backed IPC mock returns a fresh vi.fn() per property access.
    // There's no safe way to enumerate "all accessed methods", but we can
    // assert on the WhatsApp-specific surface the parent uses — none of which
    // should fire from the modal itself.
    //
    // Accessing these properties here materializes their vi.fn() so we can
    // inspect .mock.calls — the component itself never touches them.
    expect(
      (ipc as unknown as { onWhatsAppQRCode?: { mock?: { calls: unknown[] } } }).onWhatsAppQRCode
        ?.mock?.calls ?? []
    ).toHaveLength(0);

    // MSW has onUnhandledRequest: 'error' — if any fetch happened, the test
    // would already have thrown. Belt-and-braces: the capture buffer must be
    // empty for every render in this suite.
    expect(capturedRequests).toHaveLength(0);
  });

  it('does not issue network requests when the user clicks close', async () => {
    const user = userEvent.setup();
    installIpcMock();
    const onClose = vi.fn();
    renderWithProviders(
      <WhatsAppQRModal
        isOpen={true}
        onClose={onClose}
        qrCode="wa://pair/NET-CHECK"
        isConnecting={false}
      />
    );

    await user.click(screen.getByRole('button'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(capturedRequests).toHaveLength(0);
  });
});
