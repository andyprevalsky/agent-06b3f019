/**
 * STATE MACHINE: MetricChange
 * [NO_BASELINE] -> muted label
 * [POSITIVE|NEGATIVE|UNCHANGED] -> directional period comparison
 */

import { ArrowDown, ArrowUp, Minus } from 'lucide-react';

import { cn } from '@/lib/utils';

import type { AdminHealthTimeSlice } from '../types';
import { priorPeriodLabel } from './metricComparison';

export function MetricChange({
  value,
  timeSlice,
  dark = false,
  compact = false,
}: {
  value: number | null;
  timeSlice: AdminHealthTimeSlice;
  dark?: boolean;
  compact?: boolean;
}) {
  if (value === null) {
    return (
      <span className={cn('text-xs text-muted-foreground', dark && 'text-white/55')}>
        No prior baseline
      </span>
    );
  }
  const Icon = value > 0 ? ArrowUp : value < 0 ? ArrowDown : Minus;
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 1,
    signDisplay: value === 0 ? 'never' : 'always',
  }).format(value);
  const comparison = `${formatted} vs ${priorPeriodLabel(timeSlice)}`;
  return (
    <span
      aria-label={comparison}
      title={compact ? comparison : undefined}
      className={cn(
        'inline-flex items-center gap-1 text-xs font-medium',
        value > 0 && 'text-emerald-600 dark:text-emerald-400',
        value < 0 && 'text-rose-600 dark:text-rose-400',
        value === 0 && 'text-muted-foreground',
        dark && value === 0 && 'text-white/55',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {compact ? formatted : comparison}
    </span>
  );
}
