import type { AdminHealthData, AdminHealthTimeSlice } from '../types';

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
  weekly: 'prior week',
  monthly: 'prior month',
  quarterly: 'prior quarter',
  yearly: 'prior year',
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
