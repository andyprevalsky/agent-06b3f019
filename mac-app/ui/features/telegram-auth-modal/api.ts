/**
 * IPC wrappers for the telegram-auth-modal feature — the sole consumer of the
 * `window.api.telegram` surface and the four `onTelegram*` event bridges
 * inside this feature. Hooks/components never touch `window.api` directly.
 *
 * Auth flow over IPC:
 *   renderer  ──startAuth(phone)──────▶  main
 *   renderer  ◀──onTelegramNeedCode────  main
 *   renderer  ──submitCode(code)──────▶  main
 *   renderer  ◀──onTelegramNeedPassword  main   (optional, only when 2FA)
 *   renderer  ──submitPassword(pwd)──▶  main
 *   renderer  ◀──onTelegramAuthComplete  main
 *   renderer  ◀──onTelegramAuthError────  main   (at any point)
 *
 * Every helper is a thin passthrough: no retry, no caching, no throwing —
 * errors surface via the `success: false` result shape so hooks can branch.
 */

type AuthResult = { success: boolean; error?: string };

/**
 * True when the Electron preload has exposed `window.api.telegram`. The modal
 * gracefully degrades to a user-visible error when this is false (e.g. when
 * running the renderer in isolation without the Telegram host).
 */
export const isTelegramApiAvailable = (): boolean => window.api.telegram !== undefined;

export const startTelegramAuth = (phoneNumber: string): Promise<AuthResult> => {
  if (window.api.telegram === undefined) {
    return Promise.resolve({ success: false, error: 'Telegram API not available' });
  }
  return window.api.telegram.startAuth(phoneNumber);
};

export const submitTelegramCode = (code: string): Promise<AuthResult> => {
  if (window.api.telegram === undefined) {
    return Promise.resolve({ success: false, error: 'Telegram API not available' });
  }
  return window.api.telegram.submitCode(code);
};

export const submitTelegramPassword = (password: string): Promise<AuthResult> => {
  if (window.api.telegram === undefined) {
    return Promise.resolve({ success: false, error: 'Telegram API not available' });
  }
  return window.api.telegram.submitPassword(password);
};

export const cancelTelegramAuth = (): void => {
  void window.api.telegram?.cancelAuth();
};

export const onTelegramNeedCode = (callback: () => void): void => {
  window.api.onTelegramNeedCode?.(callback);
};

export const onTelegramNeedPassword = (callback: () => void): void => {
  window.api.onTelegramNeedPassword?.(callback);
};

export const onTelegramAuthComplete = (callback: () => void): void => {
  window.api.onTelegramAuthComplete?.(callback);
};

export const onTelegramAuthError = (callback: (errorMessage: string) => void): void => {
  window.api.onTelegramAuthError?.(callback);
};
