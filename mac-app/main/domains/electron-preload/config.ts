/**
 * Config for the electron-preload domain.
 *
 * `BRIDGE_KEY` is the single property name the preload installs on
 * `window` via `contextBridge.exposeInMainWorld`. Renderer code reads
 * `window.api` (see `types.ts` Window augmentation).
 */

export const BRIDGE_KEY = 'api' as const;
