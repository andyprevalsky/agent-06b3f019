/**
 * STATE MACHINE: CompletionSummaryCard
 *
 * EXPANSION STATE:
 * [COLLAPSED] <-- toolsExpanded: false (shows total count only)
 *     |
 *     | (click tools header)
 *     v
 * [EXPANDED] <-- toolsExpanded: true (shows tool breakdown)
 *     |
 *     | (click tools header)
 *     v
 * [COLLAPSED]
 *
 * States:
 * - toolsExpanded: boolean - Whether tool breakdown list is visible
 * - copiedField: string | null - Key of field currently showing "copied" feedback
 */

import { memo, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { Check, Copy } from 'lucide-react';
import { copyToClipboard } from '@/lib/clipboard';
import { isFilePointer } from './claudeCodeChip.utils';
import { FilePointerDisplay } from './FilePointerDisplay';
import { FilePointerGroup } from './inline-media/FilePointerGroup';
import type { CompletionSummaryData, OutputField } from '../types';
import type { FilePointer } from '../hooks';
import { CompletionHeader, FooterStats, ToolUsageSection } from './CompletionSummarySections';

export type { CompletionSummaryData } from '../types';

interface CompletionSummaryCardProps {
  data: CompletionSummaryData;
  className?: string;
}

function humanizeKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatValue(value: OutputField['value']): string {
  if (isFilePointer(value)) return value.original_filename;
  if (Array.isArray(value) && value.length > 0 && isFilePointer(value[0])) {
    return value.map((fp) => (fp as FilePointer).original_filename).join(', ');
  }
  if (Array.isArray(value)) {
    return value
      .map((item, index) => {
        const formatted = formatNestedValue(item);
        return isRecord(item) ? `${index + 1}. ${formatted}` : formatted;
      })
      .join('\n\n');
  }
  if (isRecord(value)) return formatRecord(value);
  if (value === null || value === undefined) return '';
  return String(value);
}

function isFilePointerValue(value: OutputField['value']): boolean {
  if (isFilePointer(value)) return true;
  if (Array.isArray(value) && value.length > 0 && isFilePointer(value[0])) return true;
  return false;
}

function formatNestedValue(value: unknown): string {
  if (isFilePointer(value)) return value.original_filename;
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    if (value.every((item) => !isRecord(item) && !Array.isArray(item))) {
      return value
        .map((item) => formatNestedValue(item))
        .filter(Boolean)
        .join(', ');
    }
    return value
      .map((item, index) => {
        const formatted = formatNestedValue(item);
        return isRecord(item) ? `${index + 1}. ${formatted}` : formatted;
      })
      .join('\n');
  }
  if (isRecord(value)) return formatRecord(value);
  if (value === null || value === undefined) return '';
  return String(value);
}

function formatRecord(record: Record<string, unknown>): string {
  return Object.entries(record)
    .map(([key, value]) => {
      const formatted = formatNestedValue(value);
      return formatted ? `${humanizeKey(key)}: ${formatted}` : humanizeKey(key);
    })
    .join('\n');
}

interface OutputValueProps {
  value: OutputField['value'];
}

function OutputValue({ value }: OutputValueProps) {
  if (isFilePointer(value)) {
    return <FilePointerDisplay file={value} showMiniPreview />;
  }
  if (Array.isArray(value) && value.length > 0 && isFilePointer(value[0])) {
    return <FilePointerGroup files={value as FilePointer[]} showMiniPreview />;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">No output</span>;
    if (value.every((item) => !isRecord(item) && !Array.isArray(item))) {
      return <>{formatValue(value)}</>;
    }
    return (
      <div className="space-y-3">
        {value.map((item, index) => (
          <StructuredValueBlock key={index} value={item} ordinal={index + 1} />
        ))}
      </div>
    );
  }
  if (isRecord(value)) {
    return <StructuredValueBlock value={value} />;
  }
  return <>{formatValue(value)}</>;
}

function StructuredValueBlock({ value, ordinal }: { value: unknown; ordinal?: number }) {
  if (Array.isArray(value)) {
    return (
      <ul className="list-disc pl-4 space-y-1">
        {value.map((item, index) => (
          <li key={index}>
            <StructuredInlineValue value={item} />
          </li>
        ))}
      </ul>
    );
  }

  if (!isRecord(value)) return <StructuredInlineValue value={value} />;

  const titleEntry = findTitleEntry(value);
  const detailEntries = Object.entries(value).filter(([key]) => key !== titleEntry?.[0]);

  return (
    <div className="rounded-md border border-border/50 bg-background/35 px-2.5 py-2 space-y-2">
      {titleEntry ? (
        <div className="text-sm font-semibold text-foreground">
          {ordinal !== undefined ? `${ordinal}. ` : ''}
          {formatNestedValue(titleEntry[1])}
        </div>
      ) : ordinal !== undefined ? (
        <div className="text-sm font-semibold text-foreground">Item {ordinal}</div>
      ) : null}
      <div className="space-y-1.5">
        {detailEntries.map(([key, nestedValue]) => (
          <StructuredField key={key} label={humanizeKey(key)} value={nestedValue} />
        ))}
      </div>
    </div>
  );
}

function findTitleEntry(record: Record<string, unknown>): [string, unknown] | undefined {
  const preferredKeys = ['section_label', 'title', 'name', 'label', 'heading'];
  for (const key of preferredKeys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return [key, value];
  }
  return undefined;
}

function StructuredField({ label, value }: { label: string; value: unknown }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return (
      <div>
        <div className="text-[10px] text-muted-foreground mb-1">{label}</div>
        <ul className="list-disc pl-4 space-y-1">
          {value.map((item, index) => (
            <li key={index} className="text-sm font-normal text-foreground/90">
              <StructuredInlineValue value={item} />
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (isRecord(value)) {
    return (
      <div>
        <div className="text-[10px] text-muted-foreground mb-1">{label}</div>
        <StructuredValueBlock value={value} />
      </div>
    );
  }

  const formatted = formatNestedValue(value);
  if (!formatted) return null;
  return (
    <div>
      <span className="text-[10px] text-muted-foreground">{label}: </span>
      <span className="text-sm font-normal text-foreground/90">{formatted}</span>
    </div>
  );
}

function StructuredInlineValue({ value }: { value: unknown }) {
  if (isRecord(value) || Array.isArray(value)) return <StructuredValueBlock value={value} />;
  return <>{formatNestedValue(value)}</>;
}

interface OutputRowProps {
  output: OutputField;
  copiedField: string | null;
  onCopy: (value: string, key: string) => void;
}

function OutputRow({ output, copiedField, onCopy }: OutputRowProps) {
  const showCopy = !isFilePointerValue(output.value);
  return (
    <div className="group bg-card rounded-md px-3 py-2 border border-border/60 hover:border-border transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] text-muted-foreground mb-0.5">{output.label}</div>
          <div className="text-sm text-foreground font-medium break-words">
            <OutputValue value={output.value} />
          </div>
        </div>
        {showCopy && (
          <button
            onClick={() => onCopy(formatValue(output.value), output.key)}
            className="flex-shrink-0 p-1 text-muted-foreground/50 hover:text-muted-foreground opacity-0 group-hover:opacity-100 transition-all"
            title="Copy to clipboard"
          >
            {copiedField === output.key ? (
              <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * CompletionSummaryCard - Displays agent completion summary with structured output and tool stats
 */
export const CompletionSummaryCard = memo(function CompletionSummaryCard({
  data,
  className,
}: CompletionSummaryCardProps) {
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const { summary, outputs, toolUsage, totalToolCalls, durationSeconds, costDollars } = data;

  // One pending "copied" reset at a time, cancelled when the card unmounts.
  const copiedResetRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(copiedResetRef.current), []);

  const handleCopy = async (value: string, fieldKey: string) => {
    await copyToClipboard(value);
    setCopiedField(fieldKey);
    clearTimeout(copiedResetRef.current);
    copiedResetRef.current = setTimeout(() => setCopiedField(null), 2000);
  };

  const totalTools = totalToolCalls || toolUsage?.reduce((sum, t) => sum + t.count, 0) || 0;
  const hasNonFileOutputs = outputs?.some((output) => !isFilePointerValue(output.value)) ?? false;

  return (
    <div className={cn('w-full', className)}>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
        className={cn(
          'rounded-lg border overflow-hidden transition-colors',
          'bg-[#EEEFF2]/60 dark:bg-[#1a1a1a]/60 border-border/60',
        )}
        style={{ backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
      >
        <CompletionHeader error={!!data.error} />
        <div className="px-3 py-3">
          <p className="text-sm text-muted-foreground leading-relaxed">{summary}</p>
        </div>
        {outputs && outputs.length > 0 && (
          <div className="px-3 pb-3">
            {hasNonFileOutputs ? (
              <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Output
              </div>
            ) : null}
            <div className="space-y-1.5">
              {outputs.map((output) =>
                isFilePointerValue(output.value) ? (
                  <OutputValue key={output.key} value={output.value} />
                ) : (
                  <OutputRow
                    key={output.key}
                    output={output}
                    copiedField={copiedField}
                    onCopy={(v, k) => void handleCopy(v, k)}
                  />
                ),
              )}
            </div>
          </div>
        )}
        {toolUsage && toolUsage.length > 0 && (
          <ToolUsageSection
            toolUsage={toolUsage}
            totalTools={totalTools}
            toolsExpanded={toolsExpanded}
            onToggle={() => setToolsExpanded(!toolsExpanded)}
          />
        )}
        <FooterStats durationSeconds={durationSeconds} costDollars={costDollars} />
      </motion.div>
    </div>
  );
});

export default CompletionSummaryCard;
