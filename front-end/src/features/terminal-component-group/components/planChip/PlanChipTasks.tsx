import { formatDeps, formatToolName, type TaskWithDeps } from './helpers';

interface PlanChipTasksProps {
  tasks: TaskWithDeps[];
  headerText: string;
  isHypothesis: boolean;
}

export function PlanChipTasks({ tasks, headerText, isHypothesis }: PlanChipTasksProps) {
  if (tasks.length === 0) return null;

  return (
    <div className="px-3 pb-3 border-t border-border/50">
      <div className="flex items-center justify-between pt-2 mb-2">
        <span className="text-xs text-muted-foreground font-medium">{headerText}</span>
      </div>
      <ul className="space-y-1.5">
        {tasks.map((task, displayIndex) => (
          <PlanTaskRow
            key={task.originalIndex}
            task={task}
            displayIndex={displayIndex}
            isHypothesis={isHypothesis}
          />
        ))}
      </ul>
    </div>
  );
}

interface PlanTaskRowProps {
  task: TaskWithDeps;
  displayIndex: number;
  isHypothesis: boolean;
}

function PlanTaskRow({ task, displayIndex, isHypothesis }: PlanTaskRowProps) {
  const hasDeps = task.deps.length > 0;
  return (
    <li className="flex items-start gap-2">
      <span className="text-muted-foreground/60 flex-shrink-0 mt-0.5 text-sm tabular-nums min-w-[1.25rem]">
        {isHypothesis ? '◇' : `${displayIndex + 1}.`}
      </span>
      <div className="leading-snug">
        <span className="text-sm text-foreground">
          {task.text}
          {hasDeps && (
            <span className="text-muted-foreground ml-1.5">{formatDeps(task.deps)}</span>
          )}
        </span>
        {task.toolName && (
          <div className="text-xs text-muted-foreground/60 mt-0.5">
            {formatToolName(task.toolName)}
          </div>
        )}
      </div>
    </li>
  );
}
