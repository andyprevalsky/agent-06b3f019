/**
 * STATE MACHINE: MetricAreaChart (stateless)
 * [RENDER] -> one metric from AdminHealthSeriesPoint[] as a currentColor area
 *             over the selected time-slice periods; null values leave gaps and
 *             dots keep isolated points visible.
 *
 * Shared by the primary Revenue chart and the secondary metric hover charts so
 * every over-time view uses the same periods, axes and themed tooltip.
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

import type { AdminHealthSeriesPoint } from '../types';
import { THEMED_TOOLTIP } from './chartTheme';

export type SeriesNumberKey = {
  [K in keyof AdminHealthSeriesPoint]: AdminHealthSeriesPoint[K] extends number | null ? K : never;
}[keyof AdminHealthSeriesPoint];

export function MetricAreaChart({
  series,
  dataKey,
  name,
  formatValue,
  formatTick = formatValue,
  domain,
}: {
  series: AdminHealthSeriesPoint[];
  dataKey: SeriesNumberKey;
  name: string;
  formatValue: (value: number) => string;
  formatTick?: (value: number) => string;
  domain?: [number, number];
}) {
  const gradientId = `${dataKey}Gradient`;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={series} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity={0.24} />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148,163,184,0.32)" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
        <YAxis
          domain={domain}
          tickFormatter={(value) => formatTick(Number(value))}
          tickLine={false}
          axisLine={false}
          fontSize={12}
        />
        <Tooltip
          {...THEMED_TOOLTIP}
          formatter={(value) =>
            value === null || value === undefined ? 'Unavailable' : formatValue(Number(value))
          }
        />
        <Area
          type="monotone"
          dataKey={dataKey}
          name={name}
          stroke="currentColor"
          strokeWidth={2}
          dot={{ r: 2 }}
          fill={`url(#${gradientId})`}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
