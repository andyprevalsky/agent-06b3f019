/**
 * STATE MACHINE: ListAgentsChip (outbound list_agents tool row)
 *
 * Main's tool-chip header ("Listed agent tree · N agents" /
 * "Searched agents: 'q' · N matches").
 * [COLLAPSED] (default) -- click header --> [EXPANDED]
 *   EXPANDED body: AgentTreeListing built from metadata.agentTree (structured
 *   view); older rows without it fall back to the text in a code block.
 * [EXPANDED] -- click header --> [COLLAPSED]
 */
import { useState } from 'react';
import type { Message } from '../../hooks';
import { MarkdownText } from '../MarkdownText';
import { buildAgentToolData } from '../message-bubble/agentToolData';
import { ToolMessageHeader } from '../message-bubble/ToolMessageHeader';
import { AgentTreeListing } from './AgentTreeListing';
import { buildAgentListing } from './agentTreeListing';

export function ListAgentsChip({
  message,
  onNavigateToAgent,
}: {
  message: Message;
  onNavigateToAgent?: (agentId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const data = buildAgentToolData(message);
  if (!data) return null;
  const listing = buildAgentListing(message.metadata?.agentTree);
  const hasBody = Boolean(listing) || data.message.trim().length > 0;
  const expandable = data.status !== 'IN_PROGRESS';
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-1" data-testid="list-agents-chip">
      <ToolMessageHeader
        data={data}
        titleText={data.title}
        isThought={false}
        hasMessage={hasBody}
        isExpandable={expandable}
        showChevron={hasBody && expandable}
        shouldBeExpanded={expanded}
        onToggle={() => setExpanded((open) => !open)}
      />
      {expanded && hasBody && (
        <div className="min-w-0 max-w-full max-h-[320px] overflow-y-auto overflow-x-hidden border-l-2 border-border pl-4 pr-2">
          {listing ? (
            <AgentTreeListing listing={listing} onNavigate={onNavigateToAgent} />
          ) : (
            <MarkdownText
              text={data.message}
              shouldAnimate={false}
              className="tool-message-markdown min-w-0 max-w-full text-sm text-muted-foreground"
            />
          )}
        </div>
      )}
    </div>
  );
}
