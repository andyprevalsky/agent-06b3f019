import { cn } from '@/lib/utils';

interface TreeHeaderProps {
  circle: string;
  title: string;
  totalAgents: number;
  allTerminal: boolean;
  anyFailed: boolean;
}

/**
 * Header line showing cluster-level status (circle + title + agent count).
 * Used by both full and collapsed views when `hideHeader` is false.
 */
export function TreeHeader({ circle, title, totalAgents, allTerminal, anyFailed }: TreeHeaderProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-1 py-0.5',
        allTerminal ? (anyFailed ? 'text-red-500' : 'text-gray-500') : 'text-foreground',
      )}
    >
      <span className="w-4 text-center select-none">{circle}</span>
      <span>{title}</span>
      <span className="text-xs text-muted-foreground">
        — {totalAgents} agent{totalAgents !== 1 ? 's' : ''}
      </span>
    </div>
  );
}

interface CollapsedHeaderProps extends TreeHeaderProps {
  goalsList: string[];
}

/**
 * Header for the collapsed view — includes the per-root goals list under the cluster line.
 */
export function CollapsedHeader({
  circle,
  title,
  totalAgents,
  allTerminal,
  goalsList,
}: CollapsedHeaderProps) {
  return (
    <div className={cn('py-0.5', allTerminal ? 'text-gray-500' : 'text-foreground')}>
      <div className="flex items-center gap-1">
        <span className="w-4 flex-shrink-0 text-center select-none">{circle}</span>
        <span>{title}</span>
        <span className="text-xs text-muted-foreground">
          — {totalAgents} agent{totalAgents !== 1 ? 's' : ''}
        </span>
      </div>
      {goalsList.map((goal, index) => (
        <div key={index} className="flex items-center gap-1">
          <span className="w-4 flex-shrink-0" />
          <span className="text-xs text-muted-foreground">- {goal}</span>
        </div>
      ))}
    </div>
  );
}
