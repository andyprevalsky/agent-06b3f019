import { POINTS_BY_SLICE } from './config';
import type { AdminHealthPeriod, AdminHealthTimeSlice } from './types';

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonths(date: Date, months: number): Date {
  // Callers must pass day-1 dates; setUTCMonth overflows month-end dates.
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

export function startOfWeek(date: Date): Date {
  const day = date.getUTCDay();
  return addDays(startOfUtcDay(date), day === 0 ? -6 : 1 - day);
}

function startForSlice(date: Date, timeSlice: AdminHealthTimeSlice): Date {
  if (timeSlice === 'monthly') {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  }
  if (timeSlice === 'quarterly') {
    const quarterMonth = Math.floor(date.getUTCMonth() / 3) * 3;
    return new Date(Date.UTC(date.getUTCFullYear(), quarterMonth, 1));
  }
  if (timeSlice === 'yearly') return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return startOfWeek(date);
}

function addSlice(date: Date, timeSlice: AdminHealthTimeSlice, amount: number): Date {
  if (timeSlice === 'monthly') return addMonths(date, amount);
  if (timeSlice === 'quarterly') return addMonths(date, amount * 3);
  if (timeSlice === 'yearly') {
    const next = new Date(date);
    next.setUTCFullYear(next.getUTCFullYear() + amount);
    return next;
  }
  return addDays(date, amount * 7);
}

function formatPeriodKey(date: Date, timeSlice: AdminHealthTimeSlice): string {
  const year = date.getUTCFullYear();
  if (timeSlice === 'yearly') return String(year);
  if (timeSlice === 'quarterly') return `${year}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  if (timeSlice === 'monthly') return `${year}-${month}`;
  return `${year}-${month}-${String(date.getUTCDate()).padStart(2, '0')}`;
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

export function buildPeriods(
  timeSlice: AdminHealthTimeSlice,
  now = new Date()
): AdminHealthPeriod[] {
  const currentStart = startForSlice(now, timeSlice);
  const count = POINTS_BY_SLICE[timeSlice];
  const firstStart = addSlice(currentStart, timeSlice, 1 - count);
  return Array.from({ length: count }, (_, index) => {
    const start = addSlice(firstStart, timeSlice, index);
    const end = addSlice(start, timeSlice, 1);
    return {
      key: formatPeriodKey(start, timeSlice),
      label: formatPeriodLabel(start, timeSlice),
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
