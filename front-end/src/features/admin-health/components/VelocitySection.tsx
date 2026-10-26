/**
 * STATE MACHINE: VelocitySection
 * [READY] -> current values + time-bucketed charts
 * [PARTIAL] -> unavailable badge for any provider metric without data
 */

import { AlertCircle, GitCommitHorizontal, TrendingUp } from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { AdminHealthData, AdminHealthTimeSlice, AdminHealthVelocityMetric } from '../types';
import { MetricChange } from './MetricChange';
import { seriesMetricChange } from './metricComparison';

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

function SectionPanel({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border/50 bg-background/85 p-5 shadow-sm backdrop-blur-md">
      <div className="mb-4">
        <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
          {eyebrow}
        </p>
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function VelocityValue({ metric }: { metric: AdminHealthVelocityMetric }) {
  if (metric.status === 'ready' && metric.value !== null) {
    return (
      <span className="text-2xl font-semibold tabular-nums">{formatNumber(metric.value)}</span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
      <AlertCircle className="h-3.5 w-3.5" />
      Unavailable
    </span>
  );
}

function VelocityMetricRow({
  metric,
  icon,
  change,
  timeSlice,
}: {
  metric: AdminHealthVelocityMetric;
  icon: React.ReactNode;
  change: number | null;
  timeSlice: AdminHealthTimeSlice;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border/50 bg-muted/20 p-4">
      <div className="flex min-w-0 gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
          {icon}
        </div>
        <div className="min-w-0">
          <p className="font-medium">{metric.label}</p>
          {metric.detail && (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{metric.detail}</p>
          )}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <VelocityValue metric={metric} />
        <div className="mt-1">
          <MetricChange value={change} timeSlice={timeSlice} />
        </div>
      </div>
    </div>
  );
}

function ChartFrame({ children }: { children: React.ReactNode }) {
  return <div className="h-[280px] w-full min-w-0">{children}</div>;
}

export default function VelocitySection({ data }: { data: AdminHealthData }) {
  return (
    <div className="space-y-4">
      <SectionPanel title="Linear Points Completed" eyebrow="Dev and ops velocity">
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          <VelocityMetricRow
            metric={data.velocity.dev.linearPointsCompleted}
            icon={<TrendingUp className="h-4 w-4" />}
            change={seriesMetricChange(data, 'andyLinearPoints')}
            timeSlice={data.timeSlice}
          />
          <VelocityMetricRow
            metric={data.velocity.ops.linearPointsCompleted}
            icon={<TrendingUp className="h-4 w-4" />}
            change={seriesMetricChange(data, 'tamaraLinearPoints')}
            timeSlice={data.timeSlice}
          />
        </div>
        <div className="mt-5" role="img" aria-label="Linear points over time">
          <ChartFrame>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.series} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="rgba(148,163,184,0.32)"
                />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
                <YAxis tickLine={false} axisLine={false} fontSize={12} />
                <Tooltip />
                <Legend />
                <Line
                  dataKey="andyLinearPoints"
                  name="Andy Linear points"
                  stroke="#2563eb"
                  strokeWidth={2}
                  connectNulls={false}
                />
                <Line
                  dataKey="tamaraLinearPoints"
                  name="Tamara Linear points"
                  stroke="#059669"
                  strokeWidth={2}
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartFrame>
        </div>
      </SectionPanel>

      <SectionPanel title="GitHub Commits Landed" eyebrow="Dev velocity">
        <VelocityMetricRow
          metric={data.velocity.dev.githubCommitsLanded}
          icon={<GitCommitHorizontal className="h-4 w-4" />}
          change={seriesMetricChange(data, 'githubCommits')}
          timeSlice={data.timeSlice}
        />
        <div className="mt-5" role="img" aria-label="GitHub commits over time">
          <ChartFrame>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.series} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="rgba(148,163,184,0.32)"
                />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
                <YAxis tickLine={false} axisLine={false} fontSize={12} />
                <Tooltip />
                <Line
                  dataKey="githubCommits"
                  name="GitHub commits"
                  stroke="currentColor"
                  strokeWidth={2}
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartFrame>
        </div>
      </SectionPanel>
    </div>
  );
}
