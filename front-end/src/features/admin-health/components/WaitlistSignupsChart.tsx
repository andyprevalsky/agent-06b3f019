/**
 * STATE MACHINE: WaitlistSignupsChart
 * [EMPTY]  -> no signups in range -> dashed placeholder
 * [READY]  -> per-period bar chart of email + phone waitlist entries
 *
 * Lives in the General Health Metrics section. Bars are driven by the same
 * rolling-period series as the rest of the dashboard, whose latest bucket now
 * includes the in-progress day, so signups made today appear immediately.
 */

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { cn } from '@/lib/utils';

import type { AdminHealthData, AdminHealthTimeSlice } from '../types';

const PERIOD_TITLE: Record<AdminHealthTimeSlice, string> = {
  weekly: '7 days',
  monthly: '30 days',
  quarterly: '90 days',
  yearly: '365 days',
};

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
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

export default function WaitlistSignupsChart({ data }: { data: AdminHealthData }) {
  const periodTitle = PERIOD_TITLE[data.timeSlice];
  const total = data.series.reduce((sum, point) => sum + (point.waitlistSignups ?? 0), 0);
  return (
    <SectionPanel
      title="Waitlist Signups"
      eyebrow={`Email + phone entries per ${periodTitle} · ${formatNumber(total)} across the range`}
    >
      {total === 0 ? (
        <div className="flex h-[280px] items-center justify-center rounded-lg border border-dashed border-border/70 text-sm text-muted-foreground">
          No waitlist signups in this range.
        </div>
      ) : (
        <div className="h-[280px] w-full min-w-0">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.series} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="rgba(148,163,184,0.32)"
              />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={12} />
              <Tooltip />
              <Bar
                dataKey="waitlistSignups"
                name="Waitlist signups"
                fill="#7c3aed"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </SectionPanel>
  );
}
