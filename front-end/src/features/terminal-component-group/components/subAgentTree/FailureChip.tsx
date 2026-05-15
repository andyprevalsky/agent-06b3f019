import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { type FailureContext } from '../../hooks';

interface FailureChipProps {
  failureContext?: FailureContext;
}

/**
 * Chip that shows failure details on hover for failed agents.
 * Shows progress estimate, verifier reasoning, trajectory, and partial data.
 */
export function FailureChip({ failureContext }: FailureChipProps) {
  if (!failureContext) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help flex-shrink-0 inline-flex items-center self-center">
            <AlertCircle className="h-4 w-4 text-red-500" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-md">
          <div className="text-xs space-y-2">
            <FailureSummary failureContext={failureContext} />
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function FailureSummary({ failureContext }: { failureContext: FailureContext }) {
  const {
    trajectory,
    progress_estimate,
    verifier_reasoning,
    partial_structured_response,
    last_reasoning,
    last_plan,
    steps_taken,
  } = failureContext;

  return (
    <>
      <div>
        <span className="font-medium text-red-500">Progress:</span> <span>{progress_estimate}</span>
      </div>

      {verifier_reasoning && (
        <LabeledBlock label="Why not complete:">
          <div className="text-foreground pl-2 text-[11px]">{verifier_reasoning}</div>
        </LabeledBlock>
      )}

      {last_reasoning && (
        <LabeledBlock label="Last thought:">
          <div className="text-foreground pl-2 text-[11px] line-clamp-3">{last_reasoning}</div>
        </LabeledBlock>
      )}

      {last_plan && last_plan.length > 0 && <PlanBlock plan={last_plan} />}

      {trajectory && trajectory.length > 0 && (
        <TrajectoryBlock trajectory={trajectory} stepsTaken={steps_taken} />
      )}

      {partial_structured_response && Object.keys(partial_structured_response).length > 0 && (
        <PartialDataBlock data={partial_structured_response} />
      )}
    </>
  );
}

function LabeledBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function PlanBlock({ plan }: { plan: string[] }) {
  return (
    <LabeledBlock label="Plan was:">
      <ul className="pl-2 text-[11px]">
        {plan.slice(0, 3).map((goal, i) => (
          <li key={i} className="truncate">
            • {goal}
          </li>
        ))}
        {plan.length > 3 && (
          <li className="text-muted-foreground">...and {plan.length - 3} more</li>
        )}
      </ul>
    </LabeledBlock>
  );
}

function TrajectoryBlock({
  trajectory,
  stepsTaken,
}: {
  trajectory: NonNullable<FailureContext['trajectory']>;
  stepsTaken: number;
}) {
  return (
    <LabeledBlock label={`Steps (${stepsTaken}):`}>
      <ul className="pl-2 text-[11px]">
        {trajectory.slice(-5).map((step, i) => (
          <li
            key={i}
            className={cn(
              'flex items-center gap-1',
              step.success ? 'text-green-600 dark:text-green-400' : 'text-red-500',
            )}
          >
            <span>{step.success ? '✓' : '✗'}</span>
            <span className="truncate">{step.tool_name}</span>
            {step.error_message && (
              <span className="text-muted-foreground truncate">
                : {step.error_message.slice(0, 30)}
              </span>
            )}
          </li>
        ))}
        {trajectory.length > 5 && (
          <li className="text-muted-foreground">...{trajectory.length - 5} earlier steps</li>
        )}
      </ul>
    </LabeledBlock>
  );
}

function PartialDataBlock({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data);
  return (
    <LabeledBlock label="Partial data extracted:">
      <ul className="pl-2 text-[11px]">
        {entries.slice(0, 3).map(([key, value]) => {
          const asStr = typeof value === 'string' ? value : JSON.stringify(value);
          const preview = asStr.slice(0, 50);
          const truncated = asStr.length > 50;
          return (
            <li key={key}>
              <span className="font-medium">{key.replace(/_/g, ' ')}:</span>{' '}
              <span className="text-muted-foreground">
                {preview}
                {truncated ? '...' : ''}
              </span>
            </li>
          );
        })}
        {entries.length > 3 && (
          <li className="text-muted-foreground">...and {entries.length - 3} more</li>
        )}
      </ul>
    </LabeledBlock>
  );
}
