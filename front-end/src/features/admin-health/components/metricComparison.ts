import type { AdminHealthData, AdminHealthFunnelStep, AdminHealthTimeSlice } from '../types';

export type SeriesMetricKey =
  | 'revenueCents'
  | 'waitlistSignups'
  | 'userCount'
  | 'tasksIssuedPerUser'
  | 'outputTokensPerTask'
  | 'taskCompletionRate'
  | 'andyLinearPoints'
  | 'githubCommits'
  | 'tamaraLinearPoints';

const PRIOR_LABEL: Record<AdminHealthTimeSlice, string> = {
  weekly: 'prior 7 days',
  monthly: 'prior 30 days',
  quarterly: 'prior 90 days',
  yearly: 'prior 365 days',
};

export function priorPeriodLabel(timeSlice: AdminHealthTimeSlice): string {
  return PRIOR_LABEL[timeSlice];
}

export function relativeChange(
  current: number | null | undefined,
  previous: number | null | undefined,
): number | null {
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return null;
  }
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / previous;
}

export function seriesMetricChange(data: AdminHealthData, key: SeriesMetricKey): number | null {
  const current = data.series.at(-1)?.[key];
  const previous = data.series.at(-2)?.[key];
  return relativeChange(current, previous);
}

export function funnelEndToEnd(steps: AdminHealthFunnelStep[]) {
  const first = steps[0];
  const last = steps.at(-1);
  const conversionRate =
    first?.count === null ||
    first?.count === undefined ||
    first.count === 0 ||
    last?.count === null ||
    last?.count === undefined ||
    last.count > first.count
      ? null
      : last.count / first.count;
  const previousConversionRate =
    first?.previousCount === null ||
    first?.previousCount === undefined ||
    first.previousCount === 0 ||
    last?.previousCount === null ||
    last?.previousCount === undefined ||
    last.previousCount > first.previousCount
      ? null
      : last.previousCount / first.previousCount;
  return {
    conversionRate,
    conversionRateChange: relativeChange(conversionRate, previousConversionRate),
  };
}
