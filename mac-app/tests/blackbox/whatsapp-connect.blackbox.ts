/**
 * WhatsApp pairing from the shared Integrations panel, plus the invariant that
 * lets that panel offer desktop-only actions at all.
 *
 * Background: the Mac app renders the SHARED front-end Integrations UI (the `@`
 * alias points at front-end/src). That UI decides between a real action and a
 * "Desktop Only -> Download for Mac" fallback purely by whether the matching
 * `IntegrationHandlers` entry exists. WhatsApp had a complete native bridge
 * (`window.api.whatsapp`) that was never surfaced as a handler, so the Mac app
 * showed itself a "Download for Mac" button for a capability it already had.
 *
 * The final test generalizes it: every capability the shared UI can gate on must
 * be supplied by the Mac app, so a future handler cannot be added to the shared
 * contract and silently left unwired here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useWhatsAppConnect } from '../../ui/lib/useWhatsAppConnect';

const ROOT = path.resolve(__dirname, '../..');

interface WhatsAppStub {
  hasCredentials: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  addAccount: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
}

function installApi(
  whatsapp: Partial<WhatsAppStub> | undefined,
  onWhatsAppQRCode?: (cb: (qr: string) => void) => () => void
) {
  (window as unknown as { api?: unknown }).api = { whatsapp, onWhatsAppQRCode };
}

describe('useWhatsAppConnect', () => {
  beforeEach(() => {
    delete (window as unknown as { api?: unknown }).api;
  });

  it('reports unavailable when the native bridge is absent', () => {
    installApi(undefined);
    const { result } = renderHook(() => useWhatsAppConnect());
    expect(result.current.isAvailable).toBe(false);
  });

  it('reports available when the native bridge exists', () => {
    installApi({ hasCredentials: vi.fn(), connect: vi.fn() });
    const { result } = renderHook(() => useWhatsAppConnect());
    expect(result.current.isAvailable).toBe(true);
  });

  it('resumes a previously linked device without ever showing the QR modal', async () => {
    const connect = vi.fn(async () => ({ success: true }));
    installApi({ hasCredentials: vi.fn(async () => true), connect });

    const { result } = renderHook(() => useWhatsAppConnect());
    let outcome: { success: boolean; error?: string } | undefined;
    await act(async () => {
      outcome = await result.current.connect();
    });

    expect(outcome).toEqual({ success: true });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(result.current.isModalOpen).toBe(false);
  });

  it('opens the QR modal and streams the QR when there are no stored credentials', async () => {
    let pushQR: ((qr: string) => void) | undefined;
    const unsubscribe = vi.fn();
    let resolveConnect: ((r: { success: boolean }) => void) | undefined;
    const connect = vi.fn(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          resolveConnect = resolve;
        })
    );
    installApi({ hasCredentials: vi.fn(async () => false), connect }, (cb) => {
      pushQR = cb;
      return unsubscribe;
    });

    const { result } = renderHook(() => useWhatsAppConnect());
    let pending: Promise<{ success: boolean; error?: string }> | undefined;
    act(() => {
      pending = result.current.connect();
    });

    await waitFor(() => {
      expect(result.current.isModalOpen).toBe(true);
    });
    expect(result.current.isConnecting).toBe(true);

    act(() => pushQR!('wa://pair-code'));
    await waitFor(() => {
      expect(result.current.qrCode).toBe('wa://pair-code');
    });

    await act(async () => {
      resolveConnect!({ success: true });
      await pending;
    });

    // Pairing settled: modal closed and the IPC subscription released.
    expect(result.current.isModalOpen).toBe(false);
    expect(result.current.qrCode).toBeNull();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('falls through to QR pairing when stored credentials no longer work', async () => {
    const connect = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'stale' })
      .mockResolvedValueOnce({ success: true });
    installApi({ hasCredentials: vi.fn(async () => true), connect });

    const { result } = renderHook(() => useWhatsAppConnect());
    let outcome: { success: boolean; error?: string } | undefined;
    await act(async () => {
      outcome = await result.current.connect();
    });

    expect(connect).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ success: true });
  });

  it('resolves (never throws) with the bridge error so the shared row can report it', async () => {
    const connect = vi.fn(async () => ({ success: false, error: 'phone offline' }));
    installApi({ hasCredentials: vi.fn(async () => false), connect });

    const { result } = renderHook(() => useWhatsAppConnect());
    let outcome: { success: boolean; error?: string } | undefined;
    await act(async () => {
      outcome = await result.current.connect();
    });

    expect(outcome).toEqual({ success: false, error: 'phone offline' });
    expect(result.current.isModalOpen).toBe(false);
    expect(result.current.isConnecting).toBe(false);
  });

  // Native pairing only settles when the phone scans the QR. Without this,
  // dismissing the modal left connect() pending forever and the shared
  // Integrations row spun indefinitely.
  it('settles the pending attempt when the user dismisses the QR modal', async () => {
    const neverSettles = vi.fn(() => new Promise<{ success: boolean }>(() => {}));
    installApi({ hasCredentials: vi.fn(async () => false), connect: neverSettles }, () => () => {});

    const { result } = renderHook(() => useWhatsAppConnect());
    let pending: Promise<{ success: boolean; error?: string }> | undefined;
    act(() => {
      pending = result.current.connect();
    });
    await waitFor(() => {
      expect(result.current.isModalOpen).toBe(true);
    });

    let outcome: { success: boolean; error?: string } | undefined;
    await act(async () => {
      result.current.closeModal();
      outcome = await pending;
    });

    expect(outcome?.success).toBe(false);
    expect(outcome?.error).toMatch(/canceled/i);
    expect(result.current.isConnecting).toBe(false);
    expect(result.current.isModalOpen).toBe(false);
    expect(result.current.qrCode).toBeNull();
  });

  it('ignores a late native result from a dismissed attempt', async () => {
    let settle: ((r: { success: boolean }) => void) | undefined;
    installApi(
      {
        hasCredentials: vi.fn(async () => false),
        connect: vi.fn(() => new Promise<{ success: boolean }>((r) => (settle = r))),
      },
      () => () => {}
    );

    const { result } = renderHook(() => useWhatsAppConnect());
    let pending: Promise<{ success: boolean; error?: string }> | undefined;
    act(() => {
      pending = result.current.connect();
    });
    await waitFor(() => {
      expect(result.current.isModalOpen).toBe(true);
    });

    await act(async () => {
      result.current.closeModal();
      await pending;
    });
    // The native side finally answers, after the user already gave up.
    await act(async () => {
      settle!({ success: true });
    });

    expect(result.current.isModalOpen).toBe(false);
    expect(result.current.isConnecting).toBe(false);
  });

  it('surfaces a thrown bridge failure as a resolved error and clears state', async () => {
    const connect = vi.fn(async () => {
      throw new Error('bridge crashed');
    });
    installApi({ hasCredentials: vi.fn(async () => false), connect });

    const { result } = renderHook(() => useWhatsAppConnect());
    let outcome: { success: boolean; error?: string } | undefined;
    await act(async () => {
      outcome = await result.current.connect();
    });

    expect(outcome).toEqual({ success: false, error: 'bridge crashed' });
    expect(result.current.isConnecting).toBe(false);
  });
});

describe('useWhatsAppConnect multi-account (plan row I2)', () => {
  beforeEach(() => {
    delete (window as unknown as { api?: unknown }).api;
  });

  it('addAccount always pairs a new phone behind the QR modal, even with stored credentials', async () => {
    let pushQR: ((qr: string) => void) | undefined;
    let resolveAdd: ((r: { success: boolean }) => void) | undefined;
    const connect = vi.fn(async () => ({ success: true }));
    const addAccount = vi.fn(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          resolveAdd = resolve;
        })
    );
    installApi({ hasCredentials: vi.fn(async () => true), connect, addAccount }, (cb) => {
      pushQR = cb;
      return vi.fn();
    });

    const { result } = renderHook(() => useWhatsAppConnect());
    let pending: Promise<{ success: boolean; error?: string }> | undefined;
    act(() => {
      pending = result.current.addAccount();
    });
    await waitFor(() => expect(result.current.isModalOpen).toBe(true));
    act(() => pushQR?.('qr-second-phone'));
    expect(result.current.qrCode).toBe('qr-second-phone');
    expect(connect).not.toHaveBeenCalled();

    await act(async () => {
      resolveAdd?.({ success: true });
      expect(await pending).toEqual({ success: true });
    });
    expect(addAccount).toHaveBeenCalledTimes(1);
    expect(result.current.isModalOpen).toBe(false);
    expect(result.current.qrCode).toBeNull();
  });

  it('addAccount reports unavailable on a shell without multi-account support', async () => {
    installApi({ hasCredentials: vi.fn(), connect: vi.fn() });
    const { result } = renderHook(() => useWhatsAppConnect());
    let outcome: { success: boolean; error?: string } | undefined;
    await act(async () => {
      outcome = await result.current.addAccount();
    });
    expect(outcome?.success).toBe(false);
    expect(result.current.isModalOpen).toBe(false);
  });

  it('logout signs out exactly the given phone and resolves bridge errors', async () => {
    const logout = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('bridge down'));
    installApi({ hasCredentials: vi.fn(), connect: vi.fn(), logout });
    const { result } = renderHook(() => useWhatsAppConnect());
    await act(async () => {
      expect(await result.current.logout('+15550001111')).toEqual({ success: true });
    });
    expect(logout).toHaveBeenCalledWith('+15550001111');
    await act(async () => {
      expect((await result.current.logout('+15550002222')).success).toBe(false);
    });
  });
});

describe('shared integration handler wiring', () => {
  const CONTRACT = path.join(
    ROOT,
    '../front-end/src/features/integration-handlers-context/types.ts'
  );
  const MAIN = path.join(ROOT, 'ui/main.tsx');

  /** Keys the shared UI can gate a desktop-only affordance on. */
  function contractKeys(): string[] {
    const src = fs.readFileSync(CONTRACT, 'utf8');
    const body = /export interface IntegrationHandlers \{([\s\S]*?)\n\}/.exec(src);
    expect(body).not.toBeNull();
    return [...body![1].matchAll(/^\s*(\w+)\?:/gm)].map((m) => m[1]);
  }

  it('exposes WhatsApp as a handler the shared Integrations panel can use', () => {
    expect(contractKeys()).toContain('whatsApp');
    expect(fs.readFileSync(MAIN, 'utf8')).toMatch(/whatsApp:\s*\{/);
  });

  it('passes multi-account pairing (with its QR modal) and per-phone logout to the shared UI', () => {
    const main = fs.readFileSync(MAIN, 'utf8');
    expect(main).toMatch(/addAccount:\s*whatsApp\.addAccount/);
    expect(main).toMatch(/logout:\s*whatsApp\.logout/);
  });

  it('supplies every capability the shared UI can gate on', () => {
    const main = fs.readFileSync(MAIN, 'utf8');
    const missing = contractKeys().filter((key) => !new RegExp(`\\b${key}:`).test(main));

    expect(
      missing,
      `ui/main.tsx does not provide ${missing.join(', ')}. The shared Integrations panel ` +
        'falls back to "Desktop Only -> Download for Mac" for any unwired handler, so the ' +
        'Mac app would advertise a download for a capability it already has.'
    ).toEqual([]);
  });
});
