import { FileJson } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { type OutputSchema } from '../../hooks';
import { formatFieldType, formatValue } from '../subAgentTree.helpers';

interface OutputChipProps {
  schema?: OutputSchema;
  output?: Record<string, unknown>;
  /** True for failed agents with partial data */
  isPartial?: boolean;
  /** Verifier reasoning for why the task did not complete */
  failureReason?: string;
}

/**
 * Chip that shows output schema and values on hover for agents.
 * Shows expected types from schema alongside actual extracted values.
 * For failed agents, shows partial data with a warning indicator.
 */
export function OutputChip({ schema, output, isPartial, failureReason }: OutputChipProps) {
  const hasSchema = !!schema?.fields && schema.fields.length > 0;
  const hasOutput = !!output && Object.keys(output).length > 0;

  if (!hasSchema && !hasOutput) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help flex-shrink-0 inline-flex items-center self-center">
            <FileJson className={cn('h-4 w-4', isPartial ? 'text-amber-500' : 'text-gray-400')} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-sm">
          <div className="text-xs space-y-1.5">
            {isPartial && <PartialHeader failureReason={failureReason} />}
            {hasSchema ? (
              <SchemaRows schema={schema} output={output} isPartial={isPartial} />
            ) : (
              <FallbackRows output={output} isPartial={isPartial} />
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PartialHeader({ failureReason }: { failureReason?: string }) {
  return (
    <div className="pb-1 mb-1 border-b border-border/60">
      <div className="font-medium text-amber-600 dark:text-amber-400">
        ⚠️ Partial Data (Task Failed)
      </div>
      {failureReason && (
        <div className="text-muted-foreground text-[11px] mt-0.5">
          {failureReason.length > 150 ? failureReason.slice(0, 147) + '...' : failureReason}
        </div>
      )}
    </div>
  );
}

/**
 * Schema fields with their extracted values. Shared by the hover chip and the
 * running-agents dock (`showRequired` adds the required/optional tag).
 */
export function SchemaRows({
  schema,
  output,
  isPartial,
  showRequired = false,
}: {
  schema: OutputSchema;
  output?: Record<string, unknown>;
  isPartial?: boolean;
  showRequired?: boolean;
}) {
  return (
    <>
      {schema.fields.map((field) => {
        const value = output?.[field.name];
        const hasValue = value !== undefined && value !== null;
        return (
          <div key={field.name} className="flex flex-col">
            <div className="flex items-baseline gap-1">
              <span className="font-medium">{field.name.replace(/_/g, ' ')}</span>
              <span className="text-muted-foreground text-[10px]">
                ({formatFieldType(field.type)})
              </span>
              {showRequired && (
                <span className="text-muted-foreground text-[10px]">
                  {field.required ? 'required' : 'optional'}
                </span>
              )}
            </div>
            {hasValue ? (
              <span
                className={cn(
                  'pl-2',
                  isPartial ? 'text-amber-600 dark:text-amber-400' : 'text-foreground',
                )}
              >
                {formatValue(value, field.type)}
              </span>
            ) : (
              <span className="text-muted-foreground pl-2 italic">—</span>
            )}
          </div>
        );
      })}
    </>
  );
}

function FallbackRows({
  output,
  isPartial,
}: {
  output?: Record<string, unknown>;
  isPartial?: boolean;
}) {
  return (
    <>
      {Object.entries(output || {}).map(([key, value]) => (
        <div key={key}>
          <span className="font-medium">{key.replace(/_/g, ' ')}:</span>{' '}
          <span
            className={cn(
              isPartial ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
            )}
          >
            {formatValue(value)}
          </span>
        </div>
      ))}
    </>
  );
}
