/**
 * Shim — the UpdateIndicator feature lives at `ui/features/update-indicator/`.
 *
 * This re-export is retained because existing blackbox tests reference this
 * path directly (`import UpdateIndicator from '../../ui/UpdateIndicator'`).
 * Once those tests move to the new path this file can be deleted.
 */
export { default, default as UpdateIndicator } from './features/update-indicator';
