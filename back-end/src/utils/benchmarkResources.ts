const ISOLATED_BENCHMARK_RESOURCE = /-bench-\d+-\d+-\d+$/;
const FLEET_BENCHMARK_TASK_QUEUE_PREFIX = 'navi-agent-tasks-flt-';

export function isIsolatedBenchmarkResource(name: string): boolean {
  return (
    ISOLATED_BENCHMARK_RESOURCE.test(name) || name.startsWith(FLEET_BENCHMARK_TASK_QUEUE_PREFIX)
  );
}
