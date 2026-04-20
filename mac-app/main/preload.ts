/**
 * Electron preload entry point.
 *
 * Electron loads this file by filesystem path (see `webPreferences.preload`
 * in `main/index.ts`), so it MUST stay at `main/preload.ts` — renaming or
 * moving it would break the preload bridge.
 *
 * All logic lives in `domains/electron-preload/`. Importing the runtime
 * module triggers the `contextBridge.exposeInMainWorld` side effect that
 * installs `window.api` on the renderer.
 */

import './domains/electron-preload/runtime';
