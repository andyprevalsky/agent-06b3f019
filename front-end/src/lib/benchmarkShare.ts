import { getQueryParams } from './url';

/** Bearer capability carried by a shared, read-only benchmark URL. */
export function benchmarkShareToken(): string | null {
  return getQueryParams().get('benchmark-share');
}

export function isBenchmarkSharedView(): boolean {
  return Boolean(benchmarkShareToken());
}
