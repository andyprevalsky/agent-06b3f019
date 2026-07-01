/**
 * Blackbox tests for `ui/features/telegram-auth-modal/api.ts` — the IPC
 * passthrough layer that hooks/components call instead of touching
 * `window.api` directly.
 *
 * The component-level suite (`telegram-auth-modal.blackbox.tsx`) drives the
 * legacy `TelegramAuthModal.tsx`, which pokes `window.api.telegram` inline and
 * therefore never exercises this module's guard/optional-chaining branches.
 * This suite hits the module directly to lock down the two contracts the file
 * documents:
 *
 *   1. Availability gate — when the Electron preload has NOT exposed
 *      `window.api.telegram`, the three request helpers must resolve to
 *      `{ success: false, error: 'Telegram API not available' }` WITHOUT
 *      throwing (so hooks can branch on the result shape). When the surface IS
 *      present, each helper is a thin passthrough to the matching IPC method.
 *
 *   2. Fire-and-forget bridges — `cancelTelegramAuth` and the four
 *      `onTelegram*` event subscribers use optional chaining, so they must be
 *      no-ops (never throw) when their IPC method is absent, and delegate
 *      exactly once when present.
 *
 * No MSW/network involved: this is a pure preload-boundary contract. We install
 * a hand-rolled `window.api` per test rather than using `installIpcMock`,
 * because we need to toggle the *presence* of individual methods (the whole
 * point of the branches under test) — the ipc-mock proxy fabricates a throwing
 * `vi.fn()` for any absent method, which would mask the `undefined` path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IPC } from '../../shared/types/ipc';
import {
  cancelTelegramAuth,
  isTelegramApiAvailable,
  onTelegramAuthComplete,
  onTelegramAuthError,
  onTelegramNeedCode,
  onTelegramNeedPassword,
  startTelegramAuth,
  submitTelegramCode,
  submitTelegramPassword,
} from '../../ui/features/telegram-auth-modal/api';

function setWindowApi(api: Partial<IPC>): void {
  (globalThis as unknown as { window: Window & typeof globalThis }).window = Object.assign(
    (globalThis as unknown as { window?: Window }).window ?? {},
    { api }
  ) as Window & typeof globalThis;
}

function clearWindowApi(): void {
  const w = (globalThis as unknown as { window?: { api?: IPC } }).window;
  if (w && 'api' in w) {
    delete w.api;
  }
}

beforeEach(() => {
  clearWindowApi();
});

afterEach(() => {
  clearWindowApi();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// isTelegramApiAvailable — the truthy/falsy branch
// ---------------------------------------------------------------------------

describe('telegram-auth-modal/api — isTelegramApiAvailable', () => {
  it('returns true when window.api.telegram is defined', () => {
    setWindowApi({ telegram: {} as IPC['telegram'] });
    expect(isTelegramApiAvailable()).toBe(true);
  });

  it('returns false when window.api.telegram is undefined', () => {
    setWindowApi({ telegram: undefined });
    expect(isTelegramApiAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Request helpers — the `=== undefined` guard (both branches)
// ---------------------------------------------------------------------------

describe('telegram-auth-modal/api — request helpers when API present (passthrough branch)', () => {
  it('startTelegramAuth delegates to telegram.startAuth and returns its result', async () => {
    const startAuth = vi.fn(() => Promise.resolve({ success: true }));
    setWindowApi({ telegram: { startAuth } as unknown as IPC['telegram'] });

    await expect(startTelegramAuth('+19729777432')).resolves.toEqual({ success: true });
    expect(startAuth).toHaveBeenCalledTimes(1);
    expect(startAuth).toHaveBeenCalledWith('+19729777432');
  });

  it('submitTelegramCode delegates to telegram.submitCode and returns its result', async () => {
    const submitCode = vi.fn(() => Promise.resolve({ success: false, error: 'bad code' }));
    setWindowApi({ telegram: { submitCode } as unknown as IPC['telegram'] });

    await expect(submitTelegramCode('181818')).resolves.toEqual({
      success: false,
      error: 'bad code',
    });
    expect(submitCode).toHaveBeenCalledTimes(1);
    expect(submitCode).toHaveBeenCalledWith('181818');
  });

  it('submitTelegramPassword delegates to telegram.submitPassword and returns its result', async () => {
    const submitPassword = vi.fn(() => Promise.resolve({ success: true }));
    setWindowApi({ telegram: { submitPassword } as unknown as IPC['telegram'] });

    await expect(submitTelegramPassword('hunter2')).resolves.toEqual({ success: true });
    expect(submitPassword).toHaveBeenCalledTimes(1);
    expect(submitPassword).toHaveBeenCalledWith('hunter2');
  });
});

describe('telegram-auth-modal/api — request helpers when API absent (guard branch)', () => {
  it('startTelegramAuth resolves to the not-available error without throwing', async () => {
    setWindowApi({ telegram: undefined });
    await expect(startTelegramAuth('+19729777432')).resolves.toEqual({
      success: false,
      error: 'Telegram API not available',
    });
  });

  it('submitTelegramCode resolves to the not-available error without throwing', async () => {
    setWindowApi({ telegram: undefined });
    await expect(submitTelegramCode('181818')).resolves.toEqual({
      success: false,
      error: 'Telegram API not available',
    });
  });

  it('submitTelegramPassword resolves to the not-available error without throwing', async () => {
    setWindowApi({ telegram: undefined });
    await expect(submitTelegramPassword('hunter2')).resolves.toEqual({
      success: false,
      error: 'Telegram API not available',
    });
  });
});

// ---------------------------------------------------------------------------
// Fire-and-forget bridges — optional-chaining (both branches)
// ---------------------------------------------------------------------------

describe('telegram-auth-modal/api — cancelTelegramAuth (optional chaining)', () => {
  it('invokes telegram.cancelAuth when the surface is present', () => {
    const cancelAuth = vi.fn(() => Promise.resolve({ success: true }));
    setWindowApi({ telegram: { cancelAuth } as unknown as IPC['telegram'] });

    cancelTelegramAuth();
    expect(cancelAuth).toHaveBeenCalledOnce();
  });

  it('is a no-op (does not throw) when telegram is undefined', () => {
    setWindowApi({ telegram: undefined });
    expect(() => cancelTelegramAuth()).not.toThrow();
  });
});

describe('telegram-auth-modal/api — onTelegram* event subscribers (optional chaining)', () => {
  it('registers each callback with its IPC bridge when present', () => {
    const onTelegramNeedCodeFn = vi.fn();
    const onTelegramNeedPasswordFn = vi.fn();
    const onTelegramAuthCompleteFn = vi.fn();
    const onTelegramAuthErrorFn = vi.fn();
    setWindowApi({
      onTelegramNeedCode: onTelegramNeedCodeFn,
      onTelegramNeedPassword: onTelegramNeedPasswordFn,
      onTelegramAuthComplete: onTelegramAuthCompleteFn,
      onTelegramAuthError: onTelegramAuthErrorFn,
    });

    const needCode = vi.fn();
    const needPassword = vi.fn();
    const authComplete = vi.fn();
    const authError = vi.fn();

    onTelegramNeedCode(needCode);
    onTelegramNeedPassword(needPassword);
    onTelegramAuthComplete(authComplete);
    onTelegramAuthError(authError);

    expect(onTelegramNeedCodeFn).toHaveBeenCalledTimes(1);
    expect(onTelegramNeedCodeFn).toHaveBeenCalledWith(needCode);
    expect(onTelegramNeedPasswordFn).toHaveBeenCalledTimes(1);
    expect(onTelegramNeedPasswordFn).toHaveBeenCalledWith(needPassword);
    expect(onTelegramAuthCompleteFn).toHaveBeenCalledTimes(1);
    expect(onTelegramAuthCompleteFn).toHaveBeenCalledWith(authComplete);
    expect(onTelegramAuthErrorFn).toHaveBeenCalledTimes(1);
    expect(onTelegramAuthErrorFn).toHaveBeenCalledWith(authError);
  });

  it('are no-ops (do not throw) when the bridges are absent', () => {
    setWindowApi({
      onTelegramNeedCode: undefined,
      onTelegramNeedPassword: undefined,
      onTelegramAuthComplete: undefined,
      onTelegramAuthError: undefined,
    });

    expect(() => onTelegramNeedCode(vi.fn())).not.toThrow();
    expect(() => onTelegramNeedPassword(vi.fn())).not.toThrow();
    expect(() => onTelegramAuthComplete(vi.fn())).not.toThrow();
    expect(() => onTelegramAuthError(vi.fn())).not.toThrow();
  });
});
