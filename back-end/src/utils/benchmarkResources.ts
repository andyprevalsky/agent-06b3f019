const ISOLATED_BENCHMARK_RESOURCE = /-bench-\d+-\d+-\d+$/;

export function isIsolatedBenchmarkResource(name: string): boolean {
  return ISOLATED_BENCHMARK_RESOURCE.test(name);
}
