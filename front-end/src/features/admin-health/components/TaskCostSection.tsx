/**
 * State: ready data -> scenario cards + sampled time series.
 * Null period values -> chart gap; zero sample -> explicit unavailable copy.
 */
import { useMemo } from 'react';
import { CircleDollarSign, Coins, Cpu } from 'lucide-react';
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

import type { AdminHealthData, AdminHealthTaskCostPerTask } from '../types';
import { MetricChange } from './MetricChange';
import { relativeChange } from './metricComparison';

function formatDollars(value: number | null): string {
  if (value === null) return 'Unavailable';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

function costSeriesChange(
  data: AdminHealthData,
  key: keyof AdminHealthTaskCostPerTask,
): number | null {
  const current = data.series.at(-1)?.costPerTask[key];
  const previous = data.series.at(-2)?.costPerTask[key];
  if (current === undefined || current === null || previous === undefined || previous === null) {
    return null;
  }
  return relativeChange(current, previous);
}

function CostCard({
  data,
  title,
  detail,
  metric,
  icon,
}: {
  data: AdminHealthData;
  title: string;
  detail: string;
  metric: keyof AdminHealthTaskCostPerTask;
  icon: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-background/85 p-5 shadow-sm backdrop-blur-md">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{title}</p>
          <p className="mt-2 text-3xl font-semibold tracking-normal tabular-nums">
            {formatDollars(data.summary.costPerTask[metric])}
          </p>
          <div className="mt-2">
            <MetricChange value={costSeriesChange(data, metric)} timeSlice={data.timeSlice} />
          </div>
        </div>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
          {icon}
        </div>
      </div>
      <p className="mt-4 text-xs leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
}

export default function TaskCostSection({ data }: { data: AdminHealthData }) {
  const chartData = useMemo(
    () =>
      data.series.map((point) => ({
        label: point.label,
        zeroLlmCostDollars: point.costPerTask.zeroLlmCostDollars,
        apiRateDollars: point.costPerTask.apiRateDollars,
        computeTokenRateDollars: point.costPerTask.computeTokenRateDollars,
        sampleSize: point.costPerTask.sampleSize,
      })),
    [data.series],
  );
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <CostCard
          data={data}
          title="LLM at $0"
          metric="zeroLlmCostDollars"
          detail="Non-LLM service spend per root task; compute-token LLM inference is treated as free."
          icon={<Cpu className="h-5 w-5" />}
        />
        <CostCard
          data={data}
          title="API rates (cache-aware)"
          metric="apiRateDollars"
          detail="Service spend plus LLM input, cache-read, cache-write, and output tokens at current public API rates."
          icon={<CircleDollarSign className="h-5 w-5" />}
        />
        <CostCard
          data={data}
          title="Compute-token rates"
          metric="computeTokenRateDollars"
          detail="Service spend plus the API-equivalent LLM portion at 20× lower compute-token pricing."
          icon={<Coins className="h-5 w-5" />}
        />
      </div>
      <section className="rounded-xl border border-border/50 bg-background/85 p-5 shadow-sm backdrop-blur-md">
        <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
          Real root agent runs · spawned child agents excluded
        </p>
        <h2 className="text-lg font-semibold">Cost per Root Agent Run Over Time</h2>
        <p className="mb-4 mt-1 text-xs leading-5 text-muted-foreground">
          Service costs remain in all three scenarios. DEMO-cache LLM replays have zero inference
          cost. Current sample: {data.summary.costPerTask.sampleSize.toLocaleString()} real root
          runs. Chat/setup-only sessions and simulated runs are excluded; real-model benchmark runs
          are included.
          {data.summary.costPerTask.unpricedUsageTokens > 0 && (
            <>
              {' '}
              API-rate pricing covers every model in this sample except{' '}
              {data.summary.costPerTask.unpricedUsageTokens.toLocaleString()} tokens from models
              with no published rate and no recorded cost, so the API-rate figure is a floor.
            </>
          )}
        </p>
        <div role="img" aria-label="Cost per root task over time" className="h-[280px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="rgba(148,163,184,0.32)"
              />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis
                tickFormatter={(value) => formatDollars(Number(value))}
                tickLine={false}
                axisLine={false}
                fontSize={12}
              />
              <Tooltip
                formatter={(value) =>
                  value === null || value === undefined
                    ? 'Unavailable'
                    : formatDollars(Number(value))
                }
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="zeroLlmCostDollars"
                name="LLM at $0"
                stroke="#059669"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
              <Line
                type="monotone"
                dataKey="apiRateDollars"
                name="API rates (cache-aware)"
                stroke="#dc2626"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
              <Line
                type="monotone"
                dataKey="computeTokenRateDollars"
                name="Compute-token rates (20× cheaper)"
                stroke="#7c3aed"
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}
