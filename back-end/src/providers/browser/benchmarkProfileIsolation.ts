/**
 * Local benchmark stacks run many agents against one database and backend.
 * This flag gives each browser agent its own provider profile, so concurrent
 * sessions cannot overwrite another benchmark's cookies, storage, or tabs.
 */
export function benchmarkIsolatedBrowserProfilesEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    (process.env.BENCHMARK_ISOLATED_BROWSER_PROFILES ?? '').trim().toLowerCase()
  );
}
