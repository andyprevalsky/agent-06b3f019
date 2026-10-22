/**
 * Data hook for the query-box agents banner.
 *
 * [NO SPAWN ROWS] → busId null → no subscription, 0 rows
 * [SPAWN ROWS]    → busId from the rows (root's bus) → shared useAgentTree
 *                   listener (same per-tree channel the for_each tree uses)
 *
 * 10k-agent note: one `bus:<rootId>` listener per open root view, shared with
 * every chip/tree on the page via listenToAgentTree's per-bus refcount; no
 * per-user firehose and no per-agent channels.
 */
import { useMemo } from 'react';
import { useAgentTree, type Message } from '../../hooks';
import { deriveBackgroundSpawns } from '../../hooks/backgroundSpawns';
import { buildAgentPanelModel, type AgentPanelModel } from './agentsPanelGroups';

export function resolvePanelBusId(messages: Message[]): string | null {
  for (const message of messages) {
    if (message.role !== 'TOOL') continue;
    const busId = message.metadata?.busId;
    if (typeof busId === 'string' && busId.length > 0) return busId;
  }
  return null;
}

function hasBackgroundRows(messages: Message[]): boolean {
  return messages.some(
    (m) =>
      m.metadata?.runInBackground === true ||
      (typeof m.metadata?.toolCallId === 'string' && m.metadata.toolCallId.startsWith('bg_')),
  );
}

const EMPTY_MODEL: AgentPanelModel = {
  groups: [],
  getChildren: () => [],
  counts: { total: 0, running: 0 },
};

export function useAgentsPanelData(
  selectedAgentId: string | null,
  messages: Message[],
): AgentPanelModel {
  const spawns = useMemo(() => [...deriveBackgroundSpawns(messages).values()], [messages]);
  const explicitBusId = useMemo(() => resolvePanelBusId(messages), [messages]);
  // Background general-purpose spawns can surface before any row carries a
  // busId; their tree lives on the root bus, which is this agent's when root.
  const busId =
    explicitBusId ?? (selectedAgentId && hasBackgroundRows(messages) ? selectedAgentId : null);
  const nodes = useAgentTree(selectedAgentId ? busId : null);
  return useMemo(
    () =>
      selectedAgentId ? buildAgentPanelModel({ nodes, selectedAgentId, spawns }) : EMPTY_MODEL,
    [nodes, selectedAgentId, spawns],
  );
}
