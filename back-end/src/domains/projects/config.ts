/** Projects domain limits. */

export {
  DEFAULT_STARTUP_TIMEOUT_S,
  MAX_ENV_FILE_BYTES,
  MAX_STARTUP_SCRIPT_BYTES,
  MAX_STARTUP_TIMEOUT_S,
  MIN_STARTUP_TIMEOUT_S,
} from './types';
/** Simultaneous template sandboxes per backend process (template sync). */
export const DEFAULT_MAINTENANCE_MAX_CONCURRENT_RUNS = 4;
export function maintenanceMaxConcurrentRuns(): number {
  const configured = Number(process.env.PROJECT_MAINTENANCE_MAX_CONCURRENT);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAINTENANCE_MAX_CONCURRENT_RUNS;
}
/** Encrypted git bundle / patch envelope caps (strings, after base64 + envelope). */
export const MAX_GIT_BUNDLE_ENVELOPE_CHARS = 70 * 1024 * 1024;
export const MAX_PATCH_ENVELOPE_CHARS = 25 * 1024 * 1024;
