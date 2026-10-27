/**
 * STATE MACHINE: PrimaryMetricSection
 * [READY] -> Stripe revenue value, comparison, and time series
 * [UNAVAILABLE] -> explicit unavailable value with the same stable layout
 */

import { DollarSign } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { AdminHealthData } from '../types';
import { MetricChange } from './MetricChange';
import { seriesMetricChange } from './metricComparison';
import { THEMED_TOOLTIP } from './chartTheme';

function formatCurrency(cents: number | null): string {
  if (cents === null) return 'Unavailable';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: cents >= 100_000 ? 0 : 2,
  }).format(cents / 100);
}

function moneyTick(value: number): string {
  if (Math.abs(value) >= 100_000) return `$${Math.round(value / 100_000)}k`;
  return `$${Math.round(value / 100)}`;
}

export default function PrimaryMetricSection({ data }: { data: AdminHealthData }) {
  return (
    <section
      aria-labelledby="primary-metric-title"
      className="overflow-hidden rounded-lg border border-border/60 bg-background shadow-sm"
    >
      <div className="grid min-h-[340px] grid-cols-1 xl:grid-cols-[320px_minmax(0,1fr)]">
        <div className="flex flex-col justify-between bg-navi-black p-6 text-white md:p-8">
          <div>
            <div className="mb-8 flex h-10 w-10 items-center justify-center rounded-lg bg-white/12">
              <DollarSign className="h-5 w-5" />
            </div>
            <p className="text-xs font-medium uppercase text-white/60">01 Primary Metric</p>
            <h2 id="primary-metric-title" className="mt-2 text-xl font-semibold">
              Revenue
            </h2>
            <p className="mt-3 text-4xl font-semibold tabular-nums md:text-5xl">
              {formatCurrency(data.summary.revenueCents)}
            </p>
            <div className="mt-3">
              <MetricChange
                value={seriesMetricChange(data, 'revenueCents')}
                timeSlice={data.timeSlice}
                dark
              />
            </div>
          </div>
          <p className="mt-8 text-xs leading-5 text-white/60">
            Collected revenue from the connected live Stripe account for the selected period.
          </p>
        </div>

        <div className="min-w-0 p-5 md:p-7">
          <div className="mb-3">
            <p className="text-sm font-medium">Revenue over time</p>
            <p className="text-xs text-muted-foreground">Bucketed by the selected time slice</p>
          </div>
          <div className="h-[250px] w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.series} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="revenueGradient" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="currentColor" stopOpacity={0.24} />
                    <stop offset="100%" stopColor="currentColor" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="rgba(148,163,184,0.32)"
                />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
                <YAxis tickFormatter={moneyTick} tickLine={false} axisLine={false} fontSize={12} />
                <Tooltip
                  {...THEMED_TOOLTIP}
                  formatter={(value) =>
                    formatCurrency(value === null || value === undefined ? null : Number(value))
                  }
                />
                <Area
                  type="monotone"
                  dataKey="revenueCents"
                  name="Revenue"
                  stroke="currentColor"
                  strokeWidth={2}
                  fill="url(#revenueGradient)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </section>
  );
}
