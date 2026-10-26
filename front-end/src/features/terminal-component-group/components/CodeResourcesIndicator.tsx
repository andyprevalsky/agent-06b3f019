/**
 * STATE MACHINE: CodeResourcesIndicator (item 29: a code agent's CPU / memory / disk)
 *
 *   [HIDDEN]  ← not running (completed / failed / paused), or no sample received yet
 *      │ CODE_RESOURCES sample for this task (lib/codeResources store) while running
 *      ▼
 *   [BARS]    three small vertical bars (CPU · Memory · Disk), filled to usage;
 *      │      a bar ≥ RESOURCE_WARNING_PCT (80%) is amber; an unmeasured one is empty
 *      │ hover / focus / click
 *      ▼
 *   [POPOVER] CPU "36% of 8 cores" · Memory "11 / 16 GiB 69%" + "4.9 GiB available
 *             on this box" · Disk "93 / 103 GiB 91%" + "9.8 GiB free on workspace
 *             disk" · divider · "Updated 11:02:15 AM" (viewer's local time).
 *             An unmeasured resource reads "Unavailable", never 0.
 *      │ pointer leave / click / Escape
 *      ▼
 *   [BARS]
 *
 * Renders only what the agent channel delivered: no fetch or poll on mount or hover.
 * E2B reports no app/system CPU split, so CPU has no subline.
 */

import { useState } from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  formatGiB,
  formatSampleTime,
  RESOURCE_WARNING_PCT,
  usagePct,
  useCodeResources,
  type ByteUsage,
  type CodeResourceSample,
} from '@/lib/codeResources';

const MUTED = 'text-muted-foreground dark:text-[#a3a39d]';

interface ResourceRow {
  key: 'cpu' | 'memory' | 'disk';
  label: string;
  pct: number | null;
  value: string | null;
  sub: string | null;
}

function byteRow(
  key: ResourceRow['key'],
  label: string,
  usage: ByteUsage | null,
  freeText: string,
): ResourceRow {
  if (!usage) return { key, label, pct: null, value: null, sub: null };
  const pct = usagePct(usage);
  return {
    key,
    label,
    pct,
    value: `${formatGiB(usage.used_bytes)} / ${formatGiB(usage.total_bytes)} GiB ${pct}%`,
    sub: `${formatGiB(usage.total_bytes - usage.used_bytes)} GiB ${freeText}`,
  };
}

export function resourceRows(sample: CodeResourceSample): ResourceRow[] {
  const cpuPct = sample.cpu ? Math.round(sample.cpu.used_pct) : null;
  const cores = sample.cpu?.cores ?? 0;
  return [
    {
      key: 'cpu',
      label: 'CPU',
      pct: cpuPct,
      value: sample.cpu ? `${cpuPct}% of ${cores} ${cores === 1 ? 'core' : 'cores'}` : null,
      sub: null,
    },
    byteRow('memory', 'Memory', sample.memory, 'available on this box'),
    byteRow('disk', 'Disk', sample.disk, 'free on workspace disk'),
  ];
}

function Bars({ rows }: { rows: ResourceRow[] }) {
  return (
    <span className="flex h-3.5 items-end gap-[2px]" aria-hidden="true">
      {rows.map((row) => (
        <span
          key={row.key}
          data-testid={`code-resources-bar-${row.key}`}
          data-pct={row.pct ?? ''}
          data-warning={row.pct !== null && row.pct >= RESOURCE_WARNING_PCT ? 'true' : 'false'}
          className="relative h-full w-[3px] overflow-hidden rounded-[1px] bg-muted dark:bg-white/[.12]"
        >
          {row.pct !== null && (
            <span
              className={cn(
                'absolute inset-x-0 bottom-0',
                row.pct >= RESOURCE_WARNING_PCT
                  ? 'bg-amber-500'
                  : 'bg-muted-foreground dark:bg-[#a3a39d]',
              )}
              style={{ height: `${Math.max(row.pct, 4)}%` }}
            />
          )}
        </span>
      ))}
    </span>
  );
}

export function CodeResourcesIndicator({
  taskId,
  running,
}: {
  taskId: string;
  /** Finished or paused sessions show no indicator (no live sandbox to measure). */
  running: boolean;
}) {
  const sample = useCodeResources(taskId);
  const [open, setOpen] = useState(false);
  if (!running || !sample) return null;
  const rows = resourceRows(sample);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="code-resources"
          aria-label="Sandbox CPU, memory and disk"
          onClick={(event) => event.stopPropagation()}
          onPointerEnter={(event) => event.pointerType === 'mouse' && setOpen(true)}
          onPointerLeave={(event) => event.pointerType === 'mouse' && setOpen(false)}
          className="flex items-center rounded p-1 transition-colors hover:bg-muted dark:hover:bg-white/[.06]"
        >
          <Bars rows={rows} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-testid="code-resources-popover"
        align="end"
        className="w-64 p-3 text-[13px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.key} data-testid={`code-resources-${row.key}`}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium text-foreground dark:text-[#ecece8]">{row.label}</span>
                <span
                  data-testid={`code-resources-${row.key}-value`}
                  className={cn(
                    'tabular-nums',
                    row.pct !== null && row.pct >= RESOURCE_WARNING_PCT
                      ? 'text-amber-500'
                      : 'text-foreground dark:text-[#ecece8]',
                  )}
                >
                  {row.value ?? 'Unavailable'}
                </span>
              </div>
              {row.sub && (
                <div data-testid={`code-resources-${row.key}-sub`} className={`text-xs ${MUTED}`}>
                  {row.sub}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="my-2 border-t border-border dark:border-white/[.09]" />
        <div data-testid="code-resources-updated" className={`text-xs ${MUTED}`}>
          Updated {formatSampleTime(sample.sampled_at)}
        </div>
      </PopoverContent>
    </Popover>
  );
}
