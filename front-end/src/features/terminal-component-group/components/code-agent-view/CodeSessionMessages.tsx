/** Code sessions use the main chat renderer, with one live/collapsed work slot per turn. */
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useAgentContext } from '../../hooks';
import type { LocalEcho } from '../../hooks/codeAgentLocalState';
import { eventTimeMs } from '../../hooks/codeAgentContract';
import {
  buildCodeSession,
  workLabel,
  type WorkTurn,
  type CodeSessionEntry,
} from '../../hooks/codeSessionTurns';
import { MessageListItems } from '../MessageListItems';
import type { CodeAgentConversation } from './useCodeAgentConversation';

const noop = () => {};
const empty = new Map();

function Messages({
  messages,
  owner,
}: {
  messages: ReturnType<typeof useAgentContext>['messages'];
  owner: string | null;
}) {
  return (
    <MessageListItems
      filteredMessages={messages}
      currentAnimatingId={null}
      onAnimationComplete={noop}
      selectedAgentId={owner}
      exploreStepMap={empty}
      waitForCheckMap={empty}
      streamingMetricsBySubAgentId={empty}
    />
  );
}

function WorkSlot({ turn, owner }: { turn: WorkTurn; owner: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const running = turn.status === 'running';
  useEffect(() => {
    if (!running) setExpanded(false);
  }, [running]);
  const visible = expanded ? turn.activities : running ? turn.activities.slice(-1) : [];
  return (
    <div
      data-testid="code-work-slot"
      data-turn-key={turn.key}
      data-state={turn.status}
      className="px-3.5 py-2"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{workLabel(turn)}</span>
        {turn.summary && <span>· {turn.summary}</span>}
      </button>
      <div hidden={!running && !expanded} data-testid="code-work-activities">
        <Messages messages={visible} owner={owner} />
      </div>
    </div>
  );
}

export function CodeSessionMessages({
  c,
  taskId,
  echoes,
}: {
  c: CodeAgentConversation;
  taskId: string;
  echoes: readonly LocalEcho[];
}) {
  const { messages, selectedAgentId } = useAgentContext();
  const state =
    c.chipState === 'completed' || c.chipState === 'failed' || c.chipState === 'paused'
      ? c.chipState
      : 'running';
  const entries = useMemo(
    () =>
      buildCodeSession({
        messages,
        taskId,
        ownerAgentId: selectedAgentId ?? '',
        provider: c.provider,
        sessionState: state,
        sessionEndedAt: eventTimeMs(c.meta?.ended_at),
        echoes,
      }),
    [messages, taskId, selectedAgentId, c.provider, c.meta?.ended_at, state, echoes],
  );
  return (
    <div data-testid="code-agent-transcript" className="space-y-2">
      {groupMessages(entries).map((entry) =>
        entry.kind === 'work' ? (
          <WorkSlot key={entry.key} turn={entry.turn} owner={selectedAgentId} />
        ) : (
          <Messages key={entry.key} messages={entry.messages} owner={selectedAgentId} />
        ),
      )}
    </div>
  );
}

function groupMessages(entries: CodeSessionEntry[]) {
  const groups: Array<
    | { kind: 'messages'; key: string; messages: ReturnType<typeof useAgentContext>['messages'] }
    | Extract<CodeSessionEntry, { kind: 'work' }>
  > = [];
  for (const entry of entries) {
    const previous = groups.at(-1);
    if (entry.kind === 'work') groups.push(entry);
    else if (previous?.kind === 'messages') previous.messages.push(entry.message);
    else groups.push({ kind: 'messages', key: entry.key, messages: [entry.message] });
  }
  return groups;
}
