/**
 * STATE MACHINE: SpawnedAgentToolLine
 *
 * The small rotating line under a running work row whose latest activity is a
 * spawned agent: what that agent is doing right now, as the explore chip shows.
 *
 *   explore spawn (spawn_agent, agentType explore)
 *     → its in-progress steps (exploreStepMap), else its most recent step
 *   general-purpose spawn (busId + subAgentIds)
 *     → the running children's toolsInUse from the existing bus tree subscription
 *   no current tool / any other row → renders nothing
 *
 * Several tools rotate through ExploreActiveToolCarousel (1.8 s per item).
 */
import { useMemo } from 'react';
import { getToolIcon } from '@/lib/toolIcons';
import { localizeTimestamps } from '@/lib/localDateTime';
import { filterTreeBySpawn, useAgentTree, type Message } from '../hooks';
import type { ExploreStep } from '../types';
import {
  ExploreActiveToolCarousel,
  type ExploreActiveToolCarouselItem,
} from './ExploreActiveToolCarousel';

const GENERAL_PURPOSE_AGENT_TOOLS = new Set([
  'spawn_general_purpose_agent',
  'spawn_general_purpose_agent_for_each',
  'spawn_sub_agent',
]);

function isThinkingStep(step: ExploreStep): boolean {
  return (
    step.toolName === 'spawn_agent' && (step.title === 'Explore agent thinking' || !step.title)
  );
}

function stepItem(step: ExploreStep, index: number): ExploreActiveToolCarouselItem | null {
  const text = step.title?.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return {
    key: step.toolCallId || `${step.toolName}:${step.timestamp || index}:${text}`,
    text,
    icon: getToolIcon(step.toolName || text),
  };
}

/** In-progress explore steps, else the latest one (the explore chip's carousel rule). */
function exploreToolItems(steps: ExploreStep[]): ExploreActiveToolCarouselItem[] {
  const actions = steps.filter((step) => !isThinkingStep(step));
  const active = actions.filter((step) => step.status === 'IN_PROGRESS');
  const shown = active.length > 0 ? active : actions.slice(-1);
  return shown.map(stepItem).filter((item): item is ExploreActiveToolCarouselItem => item !== null);
}

function Line({ items }: { items: ExploreActiveToolCarouselItem[] }) {
  if (items.length === 0) return null;
  return (
    <div data-testid="spawned-agent-tool-line" className="flex min-w-0 pl-[22px]">
      <ExploreActiveToolCarousel
        items={items}
        iconClassName="mr-1.5 h-3 w-3 text-muted-foreground/50"
        textClassName="text-xs text-muted-foreground/70"
      />
    </div>
  );
}

function SubAgentToolLine({ busId, subAgentIds }: { busId: string; subAgentIds: string[] }) {
  const nodes = useAgentTree(busId);
  const items = useMemo(() => {
    const seen = new Set<string>();
    const result: ExploreActiveToolCarouselItem[] = [];
    for (const node of filterTreeBySpawn(nodes, subAgentIds).values()) {
      if (node.status !== 'ACTIVE' && node.status !== 'STARTING_UP') continue;
      for (const tool of node.toolsInUse) {
        if (seen.has(tool)) continue;
        seen.add(tool);
        result.push({ key: tool, text: localizeTimestamps(tool), icon: getToolIcon(tool) });
      }
    }
    return result;
  }, [nodes, subAgentIds]);
  return <Line items={items} />;
}

export function SpawnedAgentToolLine({
  message,
  exploreSteps,
}: {
  message: Message;
  exploreSteps?: ExploreStep[];
}) {
  const metadata = message.metadata ?? {};
  const toolName = String(metadata.toolName ?? '');
  if (toolName === 'spawn_agent' && metadata.agentType === 'explore')
    return <Line items={exploreToolItems(exploreSteps ?? [])} />;
  const busId = typeof metadata.busId === 'string' ? metadata.busId : null;
  const subAgentIds = Array.isArray(metadata.subAgentIds)
    ? metadata.subAgentIds.filter((id): id is string => typeof id === 'string')
    : [];
  if (GENERAL_PURPOSE_AGENT_TOOLS.has(toolName) && busId && subAgentIds.length > 0)
    return <SubAgentToolLine busId={busId} subAgentIds={subAgentIds} />;
  return null;
}
