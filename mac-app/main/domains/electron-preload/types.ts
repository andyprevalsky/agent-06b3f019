/**
 * Local types for the electron-preload domain.
 *
 * The shape of the exposed API lives in `shared/types/ipc.ts` (the
 * cross-process contract between main and renderer). This file re-exports
 * it so every layer in the domain imports types through the same surface.
 *
 * The renderer-side `Window.api` global augmentation lives in
 * `ui/global.d.ts` — the renderer tsconfig doesn't include `main/`, so
 * declaring it here would have no effect there.
 */

export type { IPC } from '../../../shared/types/ipc';
