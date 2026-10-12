/**
 * Groups a turn's web searches into one list row.
 *
 * STATE MACHINE (walk over the filtered, timestamp-ordered messages):
 *   [NO GROUP] --root web_search TOOL row--> [OPEN GROUP] (row leads the group)
 *   [OPEN GROUP] --root web_search TOOL row--> [OPEN GROUP] (row joins, hidden)
 *   [OPEN GROUP] --ASSISTANT row (round reasoning)--> [OPEN GROUP]
 *   [OPEN GROUP] --USER row (next turn) | any other TOOL row--> [NO GROUP]
 *   end of list in [OPEN GROUP] --> live web_search stream chips join it
 *
 * Only groups with two or more searches render as one row; a single search
 * keeps its own chip. Pure: rows are not mutated and the backend rows (which
 * the model reads) are unchanged.
 */
import type { Message, StreamingTool } from '../hooks';

export interface WebSearchGroup {
  /** Stable across IN_PROGRESS -> FINISHED: the first search's tool call. */
  key: string;
  lead: Message;
  members: Message[];
  streaming: StreamingTool[];
}

export interface WebSearchTurnGrouping {
  groupsByLeadId: Map<string, WebSearchGroup>;
  hiddenMessageIds: Set<string>;
  foldedStreamingToolCallIds: Set<string>;
}

export const EMPTY_WEB_SEARCH_GROUPING: WebSearchTurnGrouping = {
  groupsByLeadId: new Map(),
  hiddenMessageIds: new Set(),
  foldedStreamingToolCallIds: new Set(),
};

function isRootWebSearch(message: Message): boolean {
  return (
    message.role === 'TOOL' &&
    message.metadata?.toolName === 'web_search' &&
    !message.metadata?.subAgentId &&
    message.metadata?.agentType !== 'explore'
  );
}

function groupKey(lead: Message): string {
  const toolCallId = lead.metadata?.toolCallId;
  return typeof toolCallId === 'string' && toolCallId ? toolCallId : lead.message_id;
}

function collectGroups(messages: Message[]): {
  groups: WebSearchGroup[];
  open: WebSearchGroup | null;
} {
  const groups: WebSearchGroup[] = [];
  let open: WebSearchGroup | null = null;
  for (const message of messages) {
    if (isRootWebSearch(message)) {
      if (open) {
        open.members.push(message);
      } else {
        open = { key: groupKey(message), lead: message, members: [message], streaming: [] };
        groups.push(open);
      }
    } else if (message.role === 'USER' || message.role === 'TOOL') {
      open = null;
    }
  }
  return { groups, open };
}

export function groupWebSearchTurns(
  messages: Message[],
  streamingTools: StreamingTool[],
): WebSearchTurnGrouping {
  const { groups, open } = collectGroups(messages);
  if (open) {
    open.streaming = streamingTools.filter((tool) => tool.tool_name === 'web_search');
  }
  const grouping: WebSearchTurnGrouping = {
    groupsByLeadId: new Map(),
    hiddenMessageIds: new Set(),
    foldedStreamingToolCallIds: new Set(),
  };
  for (const group of groups) {
    if (group.members.length + group.streaming.length < 2) continue;
    grouping.groupsByLeadId.set(group.lead.message_id, group);
    for (const member of group.members.slice(1)) grouping.hiddenMessageIds.add(member.message_id);
    for (const tool of group.streaming) grouping.foldedStreamingToolCallIds.add(tool.tool_call_id);
  }
  return grouping;
}

/** The single row a group renders as, in the shape of a web_search tool message. */
export function webSearchGroupMessage(group: WebSearchGroup): Message {
  const count = group.members.length + group.streaming.length;
  const running =
    group.streaming.length > 0 ||
    group.members.some((member) => member.metadata?.toolStatus === 'IN_PROGRESS');
  const results = group.members
    .map((member) => (member.text || '').trim())
    .filter((text) => text.length > 0);
  return {
    message_id: `web-search-group:${group.key}`,
    role: 'TOOL',
    text: results.join('\n\n---\n\n'),
    timestamp: group.lead.timestamp,
    metadata: {
      toolCallId: group.key,
      toolName: 'web_search',
      toolStatus: running ? 'IN_PROGRESS' : 'FINISHED',
      title: running ? `Searching ${count} web searches` : `Searched ${count} web searches`,
    },
  };
}
