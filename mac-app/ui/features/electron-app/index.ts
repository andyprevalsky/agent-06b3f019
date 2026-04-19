/**
 * Public API barrel for the electron-app feature.
 *
 * Only `ElectronApp` crosses the feature boundary — it is the sole consumer
 * handle used by `ui/main.tsx` (the renderer composition root). All other
 * layer files (types, config, api, hooks, components/*) are feature-internal.
 */

export { default } from './components/ElectronApp';
export { default as ElectronApp } from './components/ElectronApp';
