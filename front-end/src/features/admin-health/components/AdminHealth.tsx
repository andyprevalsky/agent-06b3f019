/**
 * STATE MACHINE: AdminHealth
 *
 * SYSTEM CONTEXT:
 * Sidebar admin tab
 *   -> AdminHealth view
 *      -> GET /api/admin-health?timeSlice=...
 *         -> backend admin check
 *         -> rolling 7|30|90|365-day periods anchored to the UTC retrieval day
 *         -> backend day + time-slice response cache
 *         -> Stripe charges + Prisma waitlist/task/user metrics + Linear/GitHub velocity
 *      -> ordered website funnel -> horizontal volume BarChart + comparison tiles
 *      -> verified-account activation -> separate BarChart + comparison tiles
 *
 * VIEW DATA:
 * [LOADING] <-- loading: true
 *     |
 *     v
 * [READY] <-- data loaded
 *     |
 *     +--> [DEFAULT:MONTHLY]
 *     +--> [SLICE:WEEKLY|MONTHLY|QUARTERLY|YEARLY] -> refetch metrics
 *     +--> [ERROR] when endpoint rejects or fails
 */

import { useMemo, useState } from 'react';
import { Activity, CircleCheckBig, Loader2, TrendingUp, Users, Zap } from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { useAdminHealthData } from '../hooks';
import { MetricChange } from './MetricChange';
import { MetricSectionHeader } from './MetricHierarchy';
import PrimaryMetricSection from './PrimaryMetricSection';
import VelocitySection from './VelocitySection';
import WaitlistSignupsChart from './WaitlistSignupsChart';
import { relativeChange, seriesMetricChange } from './metricComparison';
import type {
  AdminHealthData,
  AdminHealthFunnelStep,
  AdminHealthRetentionCohort,
  AdminHealthTimeSlice,
} from '../types';

const TIME_SLICES: Array<{ value: AdminHealthTimeSlice; label: string }> = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
];

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(value);
}

function userNoun(count: number): string {
  return count === 1 ? 'user' : 'users';
}

const PERIOD_COPY: Record<AdminHealthTimeSlice, { title: string; range: string }> = {
  weekly: { title: '7 Days', range: 'last 7 complete UTC days' },
  monthly: { title: '30 Days', range: 'last 30 complete UTC days' },
  quarterly: { title: '90 Days', range: 'last 90 complete UTC days' },
  yearly: { title: '365 Days', range: 'last 365 complete UTC days' },
};

function MetricPanel({
  title,
  value,
  detail,
  icon,
  change,
}: {
  title: string;
  value: string;
  detail?: string;
  icon: React.ReactNode;
  change: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/85 p-5 shadow-sm backdrop-blur-md">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{title}</p>
          <p className="mt-2 text-3xl font-semibold tracking-normal tabular-nums">{value}</p>
          <div className="mt-2">{change}</div>
        </div>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
          {icon}
        </div>
      </div>
      {detail && <p className="mt-4 text-xs leading-5 text-muted-foreground">{detail}</p>}
    </div>
  );
}

function SectionPanel({
  title,
  eyebrow,
  children,
  className,
}: {
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'rounded-xl border border-border/50 bg-background/85 backdrop-blur-md p-5 shadow-sm',
        className,
      )}
    >
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          {eyebrow && (
            <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
              {eyebrow}
            </p>
          )}
          <h2 className="text-lg font-semibold">{title}</h2>
        </div>
      </div>
      {children}
    </section>
  );
}

function ChartFrame({ children }: { children: React.ReactNode }) {
  return <div className="h-[280px] w-full min-w-0">{children}</div>;
}

function FunnelStepMetrics({
  step,
  timeSlice,
}: {
  step: AdminHealthFunnelStep;
  timeSlice: AdminHealthTimeSlice;
}) {
  if (step.status === 'ready' && step.count !== null) {
    return (
      <div className="mt-2 grid grid-cols-2 gap-2 border-t border-border/60 pt-2">
        <div className="min-w-0">
          <p className="text-[10px] uppercase text-muted-foreground">Volume</p>
          <p className="text-base font-semibold tabular-nums">{formatNumber(step.count)}</p>
          <MetricChange
            value={relativeChange(step.count, step.previousCount)}
            timeSlice={timeSlice}
            compact
          />
        </div>
        <div className="min-w-0">
          <p className="text-[10px] uppercase text-muted-foreground">Conversion</p>
          <p className="text-base font-semibold tabular-nums">
            {step.conversionRate === null ? 'N/A' : formatPercent(step.conversionRate)}
          </p>
          <MetricChange value={step.conversionRateChange} timeSlice={timeSlice} compact />
        </div>
      </div>
    );
  }
  return <span className="text-xs text-muted-foreground">Needs analytics</span>;
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

function FunnelGroup({
  title,
  detail,
  steps,
  timeSlice,
  chartLabel,
  listLabel,
}: {
  title: string;
  detail: string;
  steps: AdminHealthFunnelStep[];
  timeSlice: AdminHealthTimeSlice;
  chartLabel: string;
  listLabel: string;
}) {
  const endToEnd = funnelEndToEnd(steps);
  return (
    <div className="rounded-lg border border-border/60 bg-background/65 p-4">
      <div className="mb-4">
        <h3 className="font-semibold">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md bg-muted/45 px-3 py-2">
        <p className="text-xs font-medium text-muted-foreground">End-to-end conversion</p>
        <p className="text-xl font-semibold tabular-nums">
          {endToEnd.conversionRate === null
            ? 'Unavailable'
            : formatPercent(endToEnd.conversionRate)}
        </p>
        <MetricChange value={endToEnd.conversionRateChange} timeSlice={timeSlice} compact />
      </div>
      <div
        role="img"
        aria-label={chartLabel}
        className="mb-4 w-full min-w-0"
        style={{ height: Math.max(260, steps.length * 56) }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={steps}
            layout="vertical"
            margin={{ top: 8, right: 24, left: 16, bottom: 8 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              horizontal={false}
              stroke="rgba(148,163,184,0.32)"
            />
            <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
            <YAxis
              type="category"
              dataKey="label"
              width={180}
              tickLine={false}
              axisLine={false}
              fontSize={12}
            />
            <Tooltip
              formatter={(value) =>
                value === null || value === undefined ? 'Unavailable' : formatNumber(Number(value))
              }
            />
            <Bar dataKey="count" name="Volume" fill="#7c3aed" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ol
        aria-label={listLabel}
        className="grid grid-cols-1 overflow-hidden rounded-md border border-border/60 sm:grid-cols-2 xl:grid-cols-3"
      >
        {steps.map((step, index) => (
          <li key={step.id} className="min-w-0 border-b border-r border-border/60 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-semibold text-muted-foreground">
                {index + 1}
              </div>
              <p className="text-[10px] uppercase text-muted-foreground" title={step.detail}>
                {step.source === 'database' ? 'DB' : 'Amplitude'}
              </p>
            </div>
            <p className="mt-2 min-h-8 text-xs font-medium leading-4">{step.label}</p>
            <FunnelStepMetrics step={step} timeSlice={timeSlice} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function FunnelSection({ data }: { data: AdminHealthData }) {
  const acquisitionSteps = data.funnel.steps.filter((step) => step.source === 'client_analytics');
  const activationSteps = data.funnel.steps.filter((step) => step.source === 'database');
  return (
    <SectionPanel title="Conversion Funnels" eyebrow="Separate populations · valid denominators">
      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
        <FunnelGroup
          title="Website Acquisition"
          detail="Ordered Amplitude users completing every prior website step within 24 hours."
          steps={acquisitionSteps}
          timeSlice={data.timeSlice}
          chartLabel="Website acquisition funnel volume"
          listLabel="Website acquisition steps"
        />
        <FunnelGroup
          title="New-Account Activation"
          detail="Verified-phone accounts created in the period; task depth is measured before the period ends."
          steps={activationSteps}
          timeSlice={data.timeSlice}
          chartLabel="New-account activation funnel volume"
          listLabel="New-account activation steps"
        />
      </div>
    </SectionPanel>
  );
}

function buildRetentionChartRows(cohorts: AdminHealthRetentionCohort[]) {
  return Array.from({ length: 12 }, (_, week) => {
    const row: Record<string, string | number | null> = { week: `W${week}` };
    for (const cohort of cohorts) {
      const point = cohort.points.find((item) => item.week === week);
      row[cohort.label] = point ? Math.round(point.retentionRate * 100) : null;
    }
    return row;
  });
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-[280px] items-center justify-center rounded-lg border border-dashed border-border/70 text-sm text-muted-foreground">
      {label}
    </div>
  );
}

function Header({
  timeSlice,
  setTimeSlice,
}: {
  timeSlice: AdminHealthTimeSlice;
  setTimeSlice: (value: AdminHealthTimeSlice) => void;
}) {
  return (
    <div className="mb-6 rounded-xl border border-border/50 bg-background/85 p-6 shadow-sm backdrop-blur-md">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/35 px-3 py-1 text-xs text-muted-foreground">
            <Activity className="h-3.5 w-3.5" />
            Admin only
          </div>
          <h1 className="text-4xl font-bold">Company Health</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Revenue, usage, retention, and internal velocity for Rose operations.
          </p>
        </div>
        <div className="flex flex-wrap gap-2" aria-label="Time slice">
          {TIME_SLICES.map((slice) => (
            <Button
              key={slice.value}
              type="button"
              variant={timeSlice === slice.value ? 'default' : 'outline'}
              size="sm"
              onClick={() => setTimeSlice(slice.value)}
              className="min-w-20"
            >
              {slice.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

function SecondaryMetricGrid({ data }: { data: AdminHealthData }) {
  const newUsers = data.series.at(-1)?.newUsers ?? 0;
  const period = PERIOD_COPY[data.timeSlice];
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      <MetricPanel
        title="# of Users"
        value={formatNumber(data.summary.userCount)}
        detail={`${formatNumber(newUsers)} new ${userNoun(newUsers)} this period.`}
        icon={<Users className="h-5 w-5" />}
        change={
          <MetricChange value={seriesMetricChange(data, 'userCount')} timeSlice={data.timeSlice} />
        }
      />
      <MetricPanel
        title={`Avg Tasks / User / ${period.title}`}
        value={formatNumber(data.summary.tasksIssuedPerUser)}
        detail={`${formatNumber(data.summary.taskCount)} root tasks in the ${period.range} / ${formatNumber(data.summary.userCount)} ${userNoun(data.summary.userCount)}.`}
        icon={<TrendingUp className="h-5 w-5" />}
        change={
          <MetricChange
            value={seriesMetricChange(data, 'tasksIssuedPerUser')}
            timeSlice={data.timeSlice}
          />
        }
      />
      <MetricPanel
        title="Output Tokens / Task"
        value={formatNumber(data.summary.outputTokensPerTask)}
        detail="Target is value per task; output tokens are a weak proxy signal."
        icon={<Zap className="h-5 w-5" />}
        change={
          <MetricChange
            value={seriesMetricChange(data, 'outputTokensPerTask')}
            timeSlice={data.timeSlice}
          />
        }
      />
      <MetricPanel
        title="Task Completion Rate"
        value={formatPercent(data.summary.taskCompletionRate)}
        detail="Completed root tasks / all root tasks issued in the selected period."
        icon={<CircleCheckBig className="h-5 w-5" />}
        change={
          <MetricChange
            value={seriesMetricChange(data, 'taskCompletionRate')}
            timeSlice={data.timeSlice}
          />
        }
      />
    </div>
  );
}

function EfficiencyCharts({ data }: { data: AdminHealthData }) {
  const period = PERIOD_COPY[data.timeSlice];
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
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

function RetentionChart({ data }: { data: AdminHealthData }) {
  const rows = useMemo(
    () => buildRetentionChartRows(data.retentionCohorts),
    [data.retentionCohorts],
  );

  return (
    <SectionPanel
      title="Verified-User Weekly Retention"
      eyebrow="First-root-task cohorts · admins excluded"
    >
      {data.retentionCohorts.length === 0 ? (
        <EmptyChart label="No cohort activity in this range." />
      ) : (
        <ChartFrame>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="rgba(148,163,184,0.32)"
              />
              <XAxis dataKey="week" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis
                tickFormatter={(value) => `${value}%`}
                tickLine={false}
                axisLine={false}
                fontSize={12}
              />
              <Tooltip formatter={(value) => `${value}%`} />
              <Legend />
              {data.retentionCohorts.map((cohort, index) => (
                <Line
                  key={cohort.cohortWeek}
                  type="monotone"
                  dataKey={cohort.label}
                  name={`${cohort.label} (${cohort.size})`}
                  stroke="#111827"
                  strokeOpacity={
                    data.retentionCohorts.length === 1
                      ? 1
                      : 0.25 + (index / (data.retentionCohorts.length - 1)) * 0.75
                  }
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartFrame>
      )}
    </SectionPanel>
  );
}

export default function AdminHealth() {
  const [timeSlice, setTimeSlice] = useState<AdminHealthTimeSlice>('monthly');
  const { data, loading, error } = useAdminHealthData(timeSlice);

  return (
    <div className="h-full overflow-y-auto pt-20">
      <div className="container mx-auto max-w-[1400px] px-4 py-8 md:px-6">
        <Header timeSlice={timeSlice} setTimeSlice={setTimeSlice} />

        {loading && (
          <div className="flex h-[420px] items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {!loading && error && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-5 text-destructive">
            {error}
          </div>
        )}

        {!loading && !error && data && (
          <div className="space-y-12">
            <PrimaryMetricSection data={data} />

            <section aria-label="Secondary metrics" className="space-y-4">
              <MetricSectionHeader
                index="02"
                title="Secondary Metrics"
                description="The customer and product signals that compound into revenue."
              />
              <SecondaryMetricGrid data={data} />
              <EfficiencyCharts data={data} />
              <FunnelSection data={data} />
              <RetentionChart data={data} />
            </section>

            <section aria-label="General health metrics" className="space-y-4">
              <MetricSectionHeader
                index="03"
                title="General Health Metrics"
                description="Internal execution signals that support product and operational health."
              />
              <WaitlistSignupsChart data={data} />
              <VelocitySection data={data} />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
