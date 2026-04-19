/**
 * Back-compat barrel. The auto-updater domain was refactored into
 * main/domains/auto-updater/. External callers (main/index.ts and the
 * blackbox test file — which is read-only under the refactor skill) still
 * import from this path; everything below re-exports the runtime.
 */
export {
  checkForUpdates,
  downloadUpdate,
  initAutoUpdater,
  isUpdateDownloaded,
  manualCheckForUpdates,
  registerUpdateIpc,
  restartToUpdate,
  setAutoUpdaterWindow,
} from '../domains/auto-updater/runtime';
