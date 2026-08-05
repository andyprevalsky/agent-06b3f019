/**
 * STATE MACHINE: EfficiencyCharts
 * [READY] -> tasks/user, tokens/task, GMV/task, completion-rate time series
 */

import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { cn } from '@/lib/utils';

import type { AdminHealthData, AdminHealthTimeSlice } from '../types';

const PERIOD_COPY: Record<AdminHealthTimeSlice, { title: string; range: string }> = {
  weekly: { title: '7 Days', range: 'last 7 complete UTC days' },
  monthly: { title: '30 Days', range: 'last 30 complete UTC days' },
  quarterly: { title: '90 Days', range: 'last 90 complete UTC days' },
  yearly: { title: '365 Days', range: 'last 365 complete UTC days' },
};

function formatPercent(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(value);
}

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

function SectionPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className={cn(
        'rounded-xl border border-border/50 bg-background/85 p-5 shadow-sm backdrop-blur-md',
      )}
    >
      <div className="mb-4">
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function ChartFrame({ children }: { children: React.ReactNode }) {
  return <div className="h-[280px] w-full min-w-0">{children}</div>;
}

export default function EfficiencyCharts({ data }: { data: AdminHealthData }) {
  const period = PERIOD_COPY[data.timeSlice];
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 2xl:grid-cols-4">
      <SectionPanel title={`Avg Tasks / User / ${period.title}`}>
        <ChartFrame>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.series} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="rgba(148,163,184,0.32)"
              />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis tickLine={false} axisLine={false} fontSize={12} />
              <Tooltip />
              <Line
                type="monotone"
                dataKey="tasksIssuedPerUser"
                name={`Avg tasks / user / ${period.range}`}
                stroke="#7c3aed"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartFrame>
      </SectionPanel>

      <SectionPanel title="Output Tokens Per Task">
        <ChartFrame>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.series} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="rgba(148,163,184,0.32)"
              />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis tickLine={false} axisLine={false} fontSize={12} />
              <Tooltip />
              <Area
                type="monotone"
                dataKey="outputTokensPerTask"
                name="Output tokens / task"
                stroke="#d97706"
                strokeWidth={2}
                fill="#f59e0b"
                fillOpacity={0.16}
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartFrame>
      </SectionPanel>

      <SectionPanel title="GMV Per Task">
        <ChartFrame>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.series} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="rgba(148,163,184,0.32)"
              />
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
                dataKey="gmvPerTask"
                name="GMV / task"
                stroke="#0f766e"
                strokeWidth={2}
                fill="#14b8a6"
                fillOpacity={0.16}
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartFrame>
      </SectionPanel>

      <SectionPanel title="Task Completion Rate">
        <ChartFrame>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.series} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="rgba(148,163,184,0.32)"
              />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis
                domain={[0, 1]}
                tickFormatter={(value) => formatPercent(Number(value))}
                tickLine={false}
                axisLine={false}
                fontSize={12}
              />
              <Tooltip
                formatter={(value) =>
                  value === null || value === undefined
                    ? 'Unavailable'
                    : formatPercent(Number(value))
                }
              />
              <Line
                type="monotone"
                dataKey="taskCompletionRate"
                name="Completion rate"
                stroke="#059669"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartFrame>
      </SectionPanel>
    </div>
  );
}
