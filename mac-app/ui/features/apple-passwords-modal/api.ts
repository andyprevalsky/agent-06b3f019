/**
 * IPC wrappers for the apple-passwords-modal feature — the sole consumer of
 * the `window.api.openPasswordsApp` surface inside this feature. Hooks/
 * components never touch `window.api` directly.
 *
 * Note: CSV upload itself is delegated to the parent via the `onSync(file)`
 * prop — this feature never talks to the backend on its own.
 */

export const openPasswordsApp = (): Promise<{ success: boolean }> => window.api.openPasswordsApp();
