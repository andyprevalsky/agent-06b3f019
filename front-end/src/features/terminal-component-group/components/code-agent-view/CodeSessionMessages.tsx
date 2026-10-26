/**
 * Code sessions use the main chat renderer, with one live/collapsed work slot per turn.
 * WORK SLOT: [RUNNING] latest activity · [EXPANDED] history, 20 a page (WorkHistoryPager;
 *   opening a running slot lands on its latest page) · [DONE] collapses. Agent
 *   coordination (a2a) lives inside the slots; the top level never groups exchanges.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
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
import { foldSessionTranscript } from '../../hooks/codeSessionTranscript';
import { ThinkingIndicator } from '../ThinkingIndicator';
import { MessageListItems } from '../MessageListItems';
import { WorkHistoryPager } from '../WorkHistoryPager';
import { useWorkHistoryPage } from '../useWorkHistoryPage';
import type { CodeAgentConversation } from './useCodeAgentConversation';

import { CodeRoutingActivity } from './CodeRoutingActivity';
import { isRoutineAgentRouting } from './routineAgentRouting';

const noop = () => {};
const empty = new Map();

function Messages({
  messages,
  owner,
  streamingMessageId,
  healthyNativeTools,
}: {
  healthyNativeTools?: ReadonlySet<string>;
  streamingMessageId?: string;
  messages: ReturnType<typeof useAgentContext>['messages'];
  owner: string | null;
}) {
  const items = (rows: typeof messages) => (
    <MessageListItems
      filteredMessages={rows}
      streamingMessageIds={streamingMessageId ? new Set([streamingMessageId]) : undefined}
      currentAnimatingId={null}
      onAnimationComplete={noop}
      selectedAgentId={owner}
      exploreStepMap={empty}
      waitForCheckMap={empty}
      streamingMetricsBySubAgentId={empty}
    />
  );
  const isRoutine = (message: (typeof messages)[number]) =>
    isRoutineAgentRouting(message, healthyNativeTools?.has(message.message_id));
  if (!messages.some(isRoutine)) return items(messages);
  const sections: Array<{ routine: boolean; messages: typeof messages }> = [];
  for (const message of messages) {
    const routine = isRoutine(message);
    const previous = sections.at(-1);
    if (previous?.routine === routine) previous.messages.push(message);
    else sections.push({ routine, messages: [message] });
  }
  return (
    <>
      {sections.map((section) =>
        section.routine ? (
          <CodeRoutingActivity key={section.messages[0].message_id}>
            {items(section.messages)}
          </CodeRoutingActivity>
        ) : (
          <Fragment key={section.messages[0].message_id}>{items(section.messages)}</Fragment>
        ),
      )}
    </>
  );
}

function WorkSlot({
  turn,
  owner,
  healthyNativeTools,
}: {
  turn: WorkTurn;
  owner: string | null;
  healthyNativeTools: ReadonlySet<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const pages = useWorkHistoryPage(turn.activities.length);
  const running = turn.status === 'running';
  useEffect(() => {
    if (!running) setExpanded(false);
  }, [running]);
  const visible = expanded
    ? pages.slice(turn.activities)
    : running
      ? turn.activities.slice(-1)
      : [];
  return (
    <div
      data-testid="code-work-slot"
      data-turn-key={turn.key}
      data-state={turn.status}
      className="py-2"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          if (!expanded && running) pages.openAtLatest();
          setExpanded(!expanded);
        }}
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{workLabel(turn)}</span>
        {turn.summary && <span>· {turn.summary}</span>}
      </button>
      <div hidden={!running && !expanded} data-testid="code-work-activities">
        {running && (turn.isThinking || !turn.activityType || turn.streamingMessageId) && (
          <ThinkingIndicator
            compact
            isClaudeStreaming
            label={turn.streamingMessageId ? 'Streaming' : 'Thinking'}
            streamStartedAtMs={turn.startedAt ?? undefined}
            streamingTokenCount={turn.metrics?.outputTokens}
            animatedTokenCount={turn.metrics?.outputTokens}
            tokensPerSecond={turn.metrics?.tokensPerSecond}
          />
        )}
        <Messages
          messages={visible}
          healthyNativeTools={healthyNativeTools}
          owner={owner}
          streamingMessageId={running ? turn.streamingMessageId : undefined}
        />
        {expanded && <WorkHistoryPager {...pages} />}
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
  const healthyNativeTools = useMemo(
    () =>
      new Set(
        foldSessionTranscript(messages, taskId)
          .filter(
            (entry) =>
              entry.type === 'tool' &&
              (entry.tool?.status === 'running' || entry.tool?.status === 'ok'),
          )
          .map((entry) => `code:${taskId}:${entry.key}`),
      ),
    [messages, taskId],
  );
  return (
    <div data-testid="code-agent-transcript" className="space-y-2">
      {groupMessages(entries).map((entry) =>
        entry.kind === 'work' ? (
          <WorkSlot
            key={entry.key}
            turn={entry.turn}
            owner={selectedAgentId}
            healthyNativeTools={healthyNativeTools}
          />
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
