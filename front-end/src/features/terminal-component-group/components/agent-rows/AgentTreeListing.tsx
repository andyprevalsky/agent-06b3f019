/**
 * STATE MACHINE: AgentTreeListing (list_agents output as a real tree; stateless)
 *
 * Rows from agentTreeListing.ts:
 *   tree    → indented rows with ├─ └─ │ tree lines (SubAgentTree prefixes)
 *   matches → flat rows with path breadcrumbs (search results)
 * Each row: type icon (agent/explore/browser/code/phone) · status dot ·
 *   path name (mono) · relationship tag · muted goal (full on hover).
 * YOUR row is highlighted ("you are here"). Collapsed subtrees show
 *   "N children · k active"; agent rows and those counts navigate to the agent.
 * Navigable rows are keyboard buttons (tab stop; Enter/Space → navigate).
 */
import { Bot, Code2, Globe, Phone, Search, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TREE_BRANCH, TREE_LAST, TREE_VERT } from '../subAgentTree.helpers';
import type { AgentListing, ListingRow } from './agentTreeListing';

const TYPE_ICONS: Record<string, LucideIcon> = {
  agent: Bot,
  general_purpose: Bot,
  explore: Search,
  browser: Globe,
  code: Code2,
  phone: Phone,
};

function dotClass(status: string): string {
  const s = status.toLowerCase();
  if (['active', 'starting_up', 'running'].includes(s)) return 'bg-sky-500';
  if (['completed', 'done', 'success'].includes(s)) return 'bg-emerald-500';
  if (['failed', 'error'].includes(s)) return 'bg-red-500';
  return 'bg-amber-500';
}

/** True when a later row continues `level` (a sibling) before the tree climbs above it. */
function hasSiblingAt(rows: ListingRow[], index: number, level: number): boolean {
  const next = rows.slice(index + 1).find((r) => r.depth <= level);
  return Boolean(next && next.depth === level);
}

/** Tree-line prefix per row (├─ └─ │ like SubAgentTree), from row depths. */
function prefixes(rows: ListingRow[]): string[] {
  return rows.map((row, index) => {
    let line = '';
    for (let level = 1; level <= row.depth; level += 1) {
      const sibling = hasSiblingAt(rows, index, level);
      if (level === row.depth) line += sibling ? TREE_BRANCH : TREE_LAST;
      else line += sibling ? `${TREE_VERT} ` : '  ';
    }
    return line;
  });
}

function Row({
  row,
  prefix,
  onNavigate,
}: {
  row: ListingRow;
  prefix: string;
  onNavigate?: (agentId: string) => void;
}) {
  const Icon = TYPE_ICONS[row.type] ?? Bot;
  const canOpen = row.navigable && Boolean(onNavigate);
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-xs',
        row.isSelf && 'bg-primary/10 ring-1 ring-primary/30',
        canOpen && 'cursor-pointer hover:bg-muted/60',
      )}
      onClick={canOpen ? () => onNavigate!(row.id) : undefined}
      role={canOpen ? 'button' : undefined}
      tabIndex={canOpen ? 0 : undefined}
      onKeyDown={
        canOpen
          ? (event) => {
              // Keys on the nested "N children" button are that button's own.
              if (event.target !== event.currentTarget) return;
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onNavigate!(row.id);
            }
          : undefined
      }
      title={[row.path ?? row.id, row.goal].filter(Boolean).join('\n')}
      data-testid="agent-listing-row"
      data-self={row.isSelf ? 'true' : undefined}
    >
      {prefix && (
        <span className="shrink-0 whitespace-pre font-mono text-gray-400 dark:text-gray-600">
          {prefix}
        </span>
      )}
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={row.type} />
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotClass(row.status))} />
      {row.breadcrumbs.length > 0 && (
        <span className="min-w-[2rem] shrink truncate font-mono text-muted-foreground">
          {row.breadcrumbs.join(' › ')} ›
        </span>
      )}
      <span className="min-w-0 shrink-0 truncate font-mono text-foreground">{row.name}</span>
      <span
        className={cn(
          'shrink-0 rounded px-1 text-[10px]',
          row.isSelf ? 'bg-primary/20 text-foreground' : 'bg-muted text-muted-foreground',
        )}
        data-testid="agent-listing-relation"
      >
        {row.isSelf ? 'you are here' : row.relation}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.goal}</span>
      {row.hiddenChildren && (
        <button
          type="button"
          className="shrink-0 text-[10px] text-muted-foreground underline-offset-2 hover:underline"
          onClick={(event) => {
            event.stopPropagation();
            onNavigate?.(row.id);
          }}
          data-testid="agent-listing-hidden-children"
        >
          {row.hiddenChildren}
        </button>
      )}
    </div>
  );
}

export function AgentTreeListing({
  listing,
  onNavigate,
}: {
  listing: AgentListing;
  onNavigate?: (agentId: string) => void;
}) {
  const linePrefixes = listing.mode === 'tree' ? prefixes(listing.rows) : [];
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-0.5" data-testid="agent-tree-listing">
      {listing.mode === 'matches' && (
        <p className="text-xs text-muted-foreground">
          {listing.rows.length} match{listing.rows.length === 1 ? '' : 'es'}
        </p>
      )}
      {listing.rows.map((row, index) => (
        <Row key={row.id} row={row} prefix={linePrefixes[index] ?? ''} onNavigate={onNavigate} />
      ))}
      {listing.hasMore && (
        <p className="text-[10px] text-muted-foreground">More on the next page…</p>
      )}
    </div>
  );
}
