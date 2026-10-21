/** Collapsed by default. Details mount only on demand and stay bounded to one page. */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { AgentToAgentRow } from './AgentToAgentRow';
import { exchangePace, type AgentExchangeGroup as Group } from './agentExchangeGroups';
const PAGE_SIZE = 20;
export function AgentExchangeGroup({
  group,
  viewerId,
  now,
}: {
  group: Group;
  viewerId: string | null;
  now: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const lastPage = Math.max(0, Math.ceil(group.exchanges.length / PAGE_SIZE) - 1);
  const activePage = Math.min(page, lastPage);
  const pace = group.metricsUnknown ? null : exchangePace(group, now);
  return (
    <div
      data-testid="agent-exchange-group"
      data-group-key={group.key}
      className="min-w-0 py-1 text-xs text-muted-foreground"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 text-left"
      >
        {expanded ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
        <span>Agents coordinating</span>
        {!group.metricsUnknown && (
          <span>
            {group.exchanges.length} {group.exchanges.length === 1 ? 'exchange' : 'exchanges'}
          </span>
        )}
        {pace && <span>{pace}</span>}
      </button>
      {expanded && (
        <div
          data-testid="agent-exchange-details"
          className="mt-2 max-h-64 space-y-3 overflow-y-auto overscroll-contain border-l border-border pl-3"
        >
          {group.exchanges
            .slice(activePage * PAGE_SIZE, (activePage + 1) * PAGE_SIZE)
            .map(({ key, a2a }) => (
              <AgentToAgentRow
                key={key}
                compact
                a2a={{
                  ...a2a,
                  direction:
                    a2a.from.id === viewerId
                      ? 'sent'
                      : a2a.to.id === viewerId
                        ? 'received'
                        : undefined,
                }}
              />
            ))}
          {lastPage > 0 && (
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label="Previous exchanges"
                disabled={activePage === 0}
                onClick={() => setPage(activePage - 1)}
              >
                Previous
              </button>
              <span>
                {activePage + 1} / {lastPage + 1}
              </span>
              <button
                type="button"
                aria-label="Next exchanges"
                disabled={activePage === lastPage}
                onClick={() => setPage(activePage + 1)}
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
