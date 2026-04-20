/**
 * Public API barrel for the update-indicator feature.
 *
 * Only `UpdateIndicator` crosses the feature boundary — it is the sole
 * consumer handle used by `ui/main.tsx` (and the shim at
 * `ui/UpdateIndicator.tsx` kept for existing blackbox tests). All other
 * layer files (types, config, api, hooks, components/*) are feature-
 * internal.
 */

export { default } from './components/UpdateIndicator';
export { default as UpdateIndicator } from './components/UpdateIndicator';
