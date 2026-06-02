export function benchmarkSavedBrowserAuthDisabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    (process.env.BENCHMARK_DISABLE_SAVED_BROWSER_AUTH ?? '').trim().toLowerCase()
  );
}
