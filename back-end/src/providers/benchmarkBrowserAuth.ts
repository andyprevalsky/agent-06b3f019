/**
 * Benchmark kill-switch for saved browser authentication.
 *
 * When `BENCHMARK_DISABLE_SAVED_BROWSER_AUTH` is set, benchmark stacks skip
 * every saved SteelSessionAuth / cookie-bundle credential so a run starts from
 * a clean, unauthenticated browser. Shared by the auth-options provider, the
 * steel injection path, and the browser-session profile binder so the flag has
 * exactly one definition instead of a per-consumer copy.
 */
export function benchmarkSavedBrowserAuthDisabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    (process.env.BENCHMARK_DISABLE_SAVED_BROWSER_AUTH ?? '').trim().toLowerCase()
  );
}
