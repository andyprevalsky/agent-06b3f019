/** A fixed-height live carousel; the ordered history mounts only after compression. */
import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, LoaderCircle, MessagesSquare, Wrench } from 'lucide-react';
import type { Message } from '../hooks';
import type { TrajectoryWorkGroup as Group } from './trajectoryWorkGroups';
import { workLabel } from '../hooks/codeSessionTurns';
const PAGE_SIZE = 20;
export function TrajectoryWorkGroup({
  group,
  renderMessage,
  indicator,
}: {
  group: Group;
  renderMessage: (message: Message) => ReactNode;
  indicator?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const running = group.status === 'running';
  useEffect(() => {
    if (running) setExpanded(false);
  }, [running]);
  const latest = group.activities.at(-1)!;
  const comms = group.activities.filter((activity) => activity.kind === 'comms').length;
  const Icon = running ? (latest.kind === 'comms' ? MessagesSquare : LoaderCircle) : Wrench;
  const lastPage = Math.max(0, Math.ceil(group.activities.length / PAGE_SIZE) - 1);
  const activePage = Math.min(page, lastPage);
  const label = running ? latest.label : workLabel(group);
  return (
    <div
      data-testid="trajectory-work-group"
      data-group-key={group.key}
      data-state={group.status}
      className="min-w-0 py-1"
    >
      <button
        type="button"
        disabled={running}
        aria-expanded={!running && expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden text-left text-sm text-muted-foreground disabled:cursor-default"
      >
        {running ? (
          <Icon size={14} aria-hidden className="shrink-0" />
        ) : expanded ? (
          <ChevronDown size={14} aria-hidden />
        ) : (
          <ChevronRight size={14} aria-hidden />
        )}
        <span
          data-testid="trajectory-activity-line"
          className="relative min-w-0 flex-1 overflow-hidden whitespace-nowrap"
        >
          <span
            key={running ? latest.key : group.status}
            data-activity-key={latest.key}
            className={running ? 'trajectory-activity-enter block truncate' : 'block truncate'}
          >
            {running && latest.kind === 'thinking' && indicator ? indicator : label}
          </span>
        </span>
        <span className="shrink-0 whitespace-nowrap text-xs">
          {running
            ? comms > 0
              ? `${comms} exchanges`
              : 'Live'
            : `${group.activities.length} activities${comms > 0 ? ` · ${comms} exchanges` : ''}`}
        </span>
      </button>
      {!running && expanded && (
        <div
          data-testid="trajectory-work-history"
          className="mt-2 max-h-80 space-y-3 overflow-y-auto overscroll-contain border-l border-border pl-3"
        >
          {group.activities
            .slice(activePage * PAGE_SIZE, (activePage + 1) * PAGE_SIZE)
            .map(({ key, message }) => (
              <div key={key} data-testid="trajectory-history-entry">
                {renderMessage(message)}
              </div>
            ))}
          {lastPage > 0 && (
            <div className="flex gap-3 text-xs">
              <button
                type="button"
                disabled={activePage === 0}
                onClick={() => setPage(activePage - 1)}
              >
                Previous activities
              </button>
              <span>
                {activePage + 1} / {lastPage + 1}
              </span>
              <button
                type="button"
                disabled={activePage === lastPage}
                onClick={() => setPage(activePage + 1)}
              >
                Next activities
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
