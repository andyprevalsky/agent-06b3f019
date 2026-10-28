/**
 * STATE MACHINE: GmvSection
 * [READY] -> GMV summary + area chart from admin-health series.gmvCents
 *
 * SYSTEM CONTEXT:
 * PurchaseSpend CLEARED: live-mode AgentCard + order_confirmation from COMPLETED tasks,
 *   real agents only, core team + Stripe subscribers (back-end repoProductGmv)
 *   -> admin-health series.gmvCents / summary.gmvCents
 *   -> secondary GMV chart on Company Health
 */

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { cn } from '@/lib/utils';

import type { AdminHealthData } from '../types';
import { MetricChange } from './MetricChange';
import { seriesMetricChange } from './metricComparison';

function formatCurrency(cents: number): string {
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

function SectionPanel({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        'rounded-xl border border-border/50 bg-background/85 p-5 shadow-sm backdrop-blur-md',
      )}
    >
      <div className="mb-4">
        {eyebrow && (
          <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
            {eyebrow}
          </p>
        )}
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>
      {children}
    </section>
  );
}

export default function GmvSection({ data }: { data: AdminHealthData }) {
  return (
    <SectionPanel
      title="GMV"
      eyebrow="Real purchases · live AgentCard + finished-task orders · Andy, Tamara, Aman + subscribers"
    >
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-3xl font-semibold tabular-nums">
            {formatCurrency(data.summary.gmvCents)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Cleared AgentCard spend plus paid orders confirmed in agent outputs.
          </p>
        </div>
        <MetricChange value={seriesMetricChange(data, 'gmvCents')} timeSlice={data.timeSlice} />
      </div>
      <div className="h-[280px] w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data.series} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gmvGradient" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#0f766e" stopOpacity={0.28} />
                <stop offset="100%" stopColor="#0f766e" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148,163,184,0.32)" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
            <YAxis tickFormatter={moneyTick} tickLine={false} axisLine={false} fontSize={12} />
            <Tooltip
              formatter={(value) =>
                value === null || value === undefined
                  ? 'Unavailable'
                  : formatCurrency(Number(value))
              }
            />
            <Area
              type="monotone"
              dataKey="gmvCents"
              name="GMV"
              stroke="#0f766e"
              strokeWidth={2}
              fill="url(#gmvGradient)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </SectionPanel>
  );
}
