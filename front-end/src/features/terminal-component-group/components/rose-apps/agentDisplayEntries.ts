/** Display projection only: original messages and model context remain unchanged. */
import type { Message } from '../../hooks';
import type { DisplayMediaItem } from '../../hooks/codeAgentContract';
import { dedupeCodeDisplays } from '../../hooks/codeDisplayIdentity';
import { groupDisplayMedia } from '../inline-media/displayMediaGroups';

export interface AgentDisplayEntry {
  id: string;
  agentId: string;
  items: DisplayMediaItem[];
}

export function displayEntryId(message: Message): string {
  const display = message.metadata?.display;
  return typeof display === 'object' &&
    display !== null &&
    'canonical_id' in display &&
    typeof display.canonical_id === 'string' &&
    display.canonical_id
    ? display.canonical_id
    : message.message_id;
}

/** The entry the Agent Display panel shows: the selection, else the agent's latest. */
export function shownDisplayEntry(apps: {
  displayEntries: AgentDisplayEntry[];
  displaySelection: { agentId: string; id: string } | null;
  selectedAgentId: string | null;
}): AgentDisplayEntry | undefined {
  const entries = apps.displayEntries.filter((entry) => entry.agentId === apps.selectedAgentId);
  const selection = apps.displaySelection;
  return (
    entries.find((entry) => entry.id === selection?.id && entry.agentId === selection.agentId) ??
    entries.at(-1)
  );
}

export function agentDisplayEntries(agentId: string, messages: Message[]): AgentDisplayEntry[] {
  const rows = dedupeCodeDisplays(messages);
  const groups = groupDisplayMedia(rows).groupsByLeadId;
  return [...groups].map(([messageId, items]) => ({
    id: displayEntryId(rows.find((row) => row.message_id === messageId)!),
    agentId,
    items,
  }));
}
