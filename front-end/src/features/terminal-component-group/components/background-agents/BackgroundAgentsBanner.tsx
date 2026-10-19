/**
 * STATE MACHINE: BackgroundAgentsBanner (attached to the top of the query box)
 *
 * [HIDDEN]    running === 0 and no finished flash
 *     | running > 0
 *     v
 * [COLLAPSED] "Running N agents" + chevron right
 *     | click / Enter              ^ click / Escape
 *     v                            |
 * [EXPANDED]  chevron down + scrollable hierarchy rendered with the existing
 *             SubAgentTree components (TreeHeader per for_each group,
 *             TreeNodeRow per agent: circle progress glyph, cost, output
 *             chip, shimmer goal, StatusLine activity, ├─ └─ tree lines)
 *             + collapsed output-schema disclosures (DockSchema): per agent,
 *             or one results table per for_each cluster
 *
 * [COLLAPSED|EXPANDED] -- running drops to 0 --> [FINISHED FLASH]
 *     "All agents finished" for FINISHED_FLASH_MS, then [HIDDEN]
 *     (stays visible while EXPANDED so an open panel never vanishes).
 *
 * Data: useAgentsPanelData (shared per-root bus subscription + the selected
 * agent's own background rows). Remount per selected agent resets all state.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Bot, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Message, TreeNode } from '../../hooks';
import { TreeHeader } from '../subAgentTree/TreeHeader';
import { ForEachResultsDisclosure, NodeSchemaDisclosure } from './DockSchema';
import { TreeNodeRow } from '../subAgentTree/TreeNodeRow';
import { isTaskNodeId, type AgentPanelModel } from './agentsPanelGroups';
import { useAgentsPanelData } from './useAgentsPanelData';

export const FINISHED_FLASH_MS = 5000;

interface BackgroundAgentsBannerProps {
  selectedAgentId: string | null;
  messages: Message[];
  onNavigate: (agentId: string) => void;
}

function useFinishedFlash(running: number): boolean {
  const previous = useRef(running);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    const wasRunning = previous.current > 0;
    previous.current = running;
    if (running > 0) {
      setFlash(false);
      return;
    }
    if (!wasRunning) return;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), FINISHED_FLASH_MS);
    return () => clearTimeout(timer);
  }, [running]);
  return flash;
}

function headline(running: number): string {
  if (running === 0) return 'All agents finished';
  return `Running ${running} agent${running === 1 ? '' : 's'}`;
}

interface PanelBodyProps {
  groups: AgentPanelModel['groups'];
  getChildren: AgentPanelModel['getChildren'];
  onNavigate: (agentId: string) => void;
}

/** Hierarchy in the SubAgentTree language: TreeHeader per for_each group, TreeNodeRow per agent. */
function renderNodeSchema(node: TreeNode, childPrefix: string) {
  return <NodeSchemaDisclosure node={node} prefix={childPrefix} />;
}

function PanelBody({ groups, getChildren, onNavigate }: PanelBodyProps) {
  if (groups.length === 0) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">No agents yet.</p>;
  }
  return (
    <>
      {groups.map((group) => (
        <div
          key={group.key}
          className="min-w-0 px-2 py-1 font-mono text-sm"
          data-testid="agent-panel-group"
          data-group-key={group.key}
        >
          {group.header && <TreeHeader {...group.header} />}
          {group.header && <ForEachResultsDisclosure roots={group.roots} />}
          {group.roots.map((node, index) => (
            <TreeNodeRow
              key={node.agentId}
              node={node}
              isLast={index === group.roots.length - 1}
              prefix=""
              getChildren={getChildren}
              onNavigate={onNavigate}
              // for_each children share the cluster's results table instead.
              renderAfterNode={group.header ? undefined : renderNodeSchema}
            />
          ))}
        </div>
      ))}
    </>
  );
}

export function BackgroundAgentsBanner({
  selectedAgentId,
  messages,
  onNavigate,
}: BackgroundAgentsBannerProps) {
  const { groups, getChildren, counts } = useAgentsPanelData(selectedAgentId, messages);
  const [expanded, setExpanded] = useState(false);
  const flash = useFinishedFlash(counts.running);
  // Synthetic task rows (explore/browser/code) have no agent page to open.
  const navigate = (agentId: string) => {
    if (!isTaskNodeId(agentId)) onNavigate(agentId);
  };

  const visible = counts.running > 0 || flash || (expanded && groups.length > 0);
  if (!visible) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && expanded) {
      event.stopPropagation();
      setExpanded(false);
    }
  };

  return (
    // Rendered as QueryInput's topAttachment: same column and edges as the
    // input box, top corners rounded, bottom joined to the box below.
    <div
      className="relative z-10 overflow-hidden rounded-t-xl border border-b-0 border-border bg-card"
      data-testid="background-agents-banner"
      data-query-input-attachment=""
      data-running={counts.running}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        aria-controls="background-agents-panel"
      >
        <Bot className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex-1 font-medium">{headline(counts.running)}</span>
        {counts.total > counts.running && (
          <span className="text-xs text-muted-foreground">{counts.total} total</span>
        )}
        <ChevronRight
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90',
          )}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <div
          id="background-agents-panel"
          className="max-h-72 overflow-y-auto overflow-x-hidden border-t border-border/70 px-1 py-1"
          data-testid="background-agents-panel"
        >
          <PanelBody groups={groups} getChildren={getChildren} onNavigate={navigate} />
        </div>
      )}
    </div>
  );
}
