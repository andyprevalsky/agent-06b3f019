/**
 * Public API barrel for the launcher feature.
 *
 * External consumer is `ui/launcher/main.tsx` (the Quick-Query window entry
 * referenced by Vite's `launcher.html`). Internal layer files (types,
 * config, api, hooks, components/*) are feature-internal — callers must
 * import the `Launcher` component from here, never directly from
 * `components/Launcher`.
 *
 * Forward-only imports within the feature: types → config → api → hooks →
 * components → barrel.
 */

export { default as Launcher } from './components/Launcher';
export { LAUNCHER_GLOBAL_CSS } from './config';
