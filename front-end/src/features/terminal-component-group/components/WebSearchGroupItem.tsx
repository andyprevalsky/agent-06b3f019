/**
 * STATE MACHINE: WebSearchGroupItem
 *
 * [SEARCHING] any member IN_PROGRESS or a live stream chip folded in
 *   - header "Searching N web searches" with the in-progress shimmer
 *   - another search joins -> [SEARCHING] with N + 1
 *   - every member FINISHED/ERROR -> [SEARCHED]
 * [SEARCHED]
 *   - header "Searched N web searches"; chevron expands every query's result
 *
 * One row for a turn's web searches. It keeps the web_search data attributes
 * (status FINISHED only once every search is done) and takes over the
 * animation slot of any hidden member, so the insert queue keeps draining.
 */
import MessageBubble from './MessageBubble';
import { webSearchGroupMessage, type WebSearchGroup } from './webSearchTurnGroups';

interface WebSearchGroupItemProps {
  group: WebSearchGroup;
  currentAnimatingId: string | null;
  onAnimationComplete: () => void;
  agentId?: string;
  compact?: boolean;
}

export function WebSearchGroupItem({
  group,
  currentAnimatingId,
  onAnimationComplete,
  agentId,
  compact,
}: WebSearchGroupItemProps) {
  const message = webSearchGroupMessage(group);
  const animating = group.members.some((member) => member.message_id === currentAnimatingId);
  return (
    <div
      data-message-id={message.message_id}
      data-message-role="TOOL"
      data-tool-call-id={group.key}
      data-tool-name="web_search"
      data-tool-status={message.metadata?.toolStatus}
      data-web-search-count={group.members.length + group.streaming.length}
      className="min-w-0 max-w-full"
    >
      <MessageBubble
        message={message}
        shouldType={animating}
        onTypingComplete={onAnimationComplete}
        agentId={agentId}
        compact={compact}
      />
    </div>
  );
}
