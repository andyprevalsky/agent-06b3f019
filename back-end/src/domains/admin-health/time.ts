import { DAYS_BY_SLICE, POINTS_BY_SLICE } from './config';
import type { AdminHealthPeriod, AdminHealthTimeSlice } from './types';

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function startOfWeek(date: Date): Date {
  const day = date.getUTCDay();
  return addDays(startOfUtcDay(date), day === 0 ? -6 : 1 - day);
}

export function startOfNextUtcDay(date: Date): Date {
  return addDays(startOfUtcDay(date), 1);
}

export function utcDayKey(date: Date): string {
  return startOfUtcDay(date).toISOString().slice(0, 10);
}

function formatPeriodKey(date: Date): string {
  return utcDayKey(date);
}

export function formatPeriodLabel(date: Date, timeSlice: AdminHealthTimeSlice): string {
  if (timeSlice === 'yearly') return String(date.getUTCFullYear());
  if (timeSlice === 'quarterly') {
    return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`;
  }
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    ...(timeSlice === 'monthly' ? { year: 'numeric' as const } : { day: 'numeric' as const }),
    timeZone: 'UTC',
  }).format(date);
}

function formatRollingPeriodLabel(date: Date, timeSlice: AdminHealthTimeSlice): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(timeSlice === 'weekly' ? {} : { year: '2-digit' as const }),
    timeZone: 'UTC',
  }).format(date);
}

export function buildPeriods(
  timeSlice: AdminHealthTimeSlice,
  now = new Date()
): AdminHealthPeriod[] {
  const count = POINTS_BY_SLICE[timeSlice];
  const days = DAYS_BY_SLICE[timeSlice];
  const currentEnd = startOfUtcDay(now);
  const firstStart = addDays(currentEnd, -days * count);
  return Array.from({ length: count }, (_, index) => {
    const start = addDays(firstStart, days * index);
    const end = addDays(start, days);
    return {
      key: formatPeriodKey(start),
      label: formatRollingPeriodLabel(start, timeSlice),
      start: start.toISOString(),
      end: end.toISOString(),
    };
  });
}

export function findPeriodIndex(periods: AdminHealthPeriod[], date: Date): number {
  const time = date.getTime();
  return periods.findIndex(
    (period) => time >= Date.parse(period.start) && time < Date.parse(period.end)
  );
}
