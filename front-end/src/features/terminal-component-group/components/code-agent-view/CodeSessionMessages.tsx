/** Code sessions use the main chat renderer, with one live/collapsed work slot per turn. */
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
import { useAgentExchangeGroups } from '../useAgentExchangeGroups';
import { parseAgentToAgentMessage } from '../../hooks/codeAgentContract';
import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import { MessageListItems } from '../MessageListItems';
import type { CodeAgentConversation } from './useCodeAgentConversation';

import { CodeRoutingActivity } from './CodeRoutingActivity';
import { isRoutineAgentRouting } from './routineAgentRouting';

const noop = () => {};
const empty = new Map();

function Messages({
  messages,
  owner,
  streamingMessageId,
  projection,
  healthyNativeTools,
}: {
  healthyNativeTools?: ReadonlySet<string>;
  projection?: ReturnType<typeof useAgentExchangeGroups> & { viewerId?: string };
  streamingMessageId?: string;
  messages: ReturnType<typeof useAgentContext>['messages'];
  owner: string | null;
}) {
  const items = (rows: typeof messages) => (
    <MessageListItems
      filteredMessages={rows}
      agentExchangeProjection={projection}
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
  const roseDesktop = useRoseDesktop();
  const exchangeMessages = useMemo(
    () => entries.flatMap((entry) => (entry.kind === 'message' ? [entry.message] : [])),
    [entries],
  );
  const exchanges = useAgentExchangeGroups(exchangeMessages, roseDesktop, null, noop, true);
  const groups = useMemo(() => {
    const canonicalIds = new Set(messages.map((message) => message.message_id));
    const unmeasured = new Set(
      exchangeMessages
        .filter((message) => !canonicalIds.has(message.message_id))
        .flatMap((message) => {
          const a2a = parseAgentToAgentMessage(message);
          return a2a ? [JSON.stringify([a2a.from.id, a2a.to.id, a2a.message_id])] : [];
        }),
    );
    return {
      ...exchanges.groups,
      groupsByLeadId: new Map(
        [...exchanges.groups.groupsByLeadId].map(([id, group]) => [
          id,
          {
            ...group,
            metricsUnknown: group.exchanges.some((exchange) => unmeasured.has(exchange.key)),
          },
        ]),
      ),
    };
  }, [messages, exchangeMessages, exchanges.groups]);
  const projection = { ...exchanges, groups, viewerId: taskId };
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
          <Messages
            key={
              entry.messages
                .map((message) => groups.groupsByLeadId.get(message.message_id)?.key)
                .find(Boolean) ?? entry.key
            }
            messages={entry.messages}
            owner={selectedAgentId}
            projection={projection}
          />
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
