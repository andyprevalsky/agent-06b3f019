/** Only the open Phone app mounts an exact selected-agent scoped reader. */
import { useCallback, useContext, useEffect, useState } from 'react';
import { AgentContext } from '../../hooks';
import { useRoseApps } from './roseAppsState';
import { phoneAppTarget } from './phoneAppTarget';
import { PhoneAttentionNotice } from '../browser-status-bar/phone/PhoneAttentionNotice';
import { PhoneOverlay } from '../browser-status-bar/phone/PhoneOverlay';
import { phoneActivityKey } from '../browser-status-bar/phone/phoneOverlayState';
import { usePhoneAttention } from '../browser-status-bar/phone/usePhoneAttention';
import { usePhoneOverlay } from '../browser-status-bar/phone/usePhoneOverlay';
import type { Message } from '../../hooks';
function PhoneSession({
  agentId,
  taskId,
  messages,
  readOnly,
  onCompleted,
}: {
  agentId: string;
  taskId: string;
  messages: Message[];
  readOnly: boolean;
  onCompleted: (agentId: string, taskId: string, requestId: string) => void;
}) {
  const attention = usePhoneAttention(taskId, agentId, messages, readOnly);
  useEffect(() => {
    if (attention.request?.completedAt) onCompleted(agentId, taskId, attention.request.id);
  }, [agentId, taskId, attention.request, onCompleted]);
  const phone = usePhoneOverlay(
    taskId,
    attention.id ? `auth:${attention.id}` : phoneActivityKey(messages, taskId),
    readOnly,
    attention.request,
    agentId,
  );
  return (
    <div
      data-testid="phone-screen"
      data-agent-id={agentId}
      data-browser-task-id={taskId}
      className="relative flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[36px] bg-[#0d0d0f]"
    >
      {!phone.visible && (attention.error || attention.request?.completedAt) && (
        <PhoneAttentionNotice attention={attention} lease={phone.snapshot?.lease} />
      )}
      <PhoneOverlay phone={phone} readOnly={readOnly} attention={attention} />
      {!phone.visible &&
        !phone.error &&
        !phone.queueTimedOut &&
        !attention.error &&
        !attention.request?.completedAt && (
          <p role="status" className="m-auto px-6 text-center text-sm text-white/70">
            Checking this agent’s phone connection…
          </p>
        )}
    </div>
  );
}
export function PhoneAppScreen() {
  const [completedTask, setCompletedTask] = useState<{
    agentId: string;
    taskId: string;
    requestId: string;
  } | null>(null);
  const rememberCompleted = useCallback((agentId: string, taskId: string, requestId: string) => {
    setCompletedTask((previous) =>
      previous?.agentId === agentId &&
      previous.taskId === taskId &&
      previous.requestId === requestId
        ? previous
        : { agentId, taskId, requestId },
    );
  }, []);
  const apps = useRoseApps();
  const context = useContext(AgentContext);
  const agent = context?.agent;
  const selected = apps?.selectedAgentId;
  const current =
    selected &&
    context?.selectedAgentId === selected &&
    agent?.agent_id === selected &&
    !context.isLoadingAgent;
  useEffect(() => {
    setCompletedTask(null);
  }, [selected]);
  const messages = current ? context.messages : [];
  const completed = completedTask?.agentId === selected ? completedTask : null;
  const taskId = current
    ? phoneAppTarget(selected, messages, apps.tabs, completed ?? undefined)
    : null;
  if (!taskId || !current)
    return (
      <div
        data-testid="phone-screen"
        className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-[36px] bg-[#0d0d0f] px-6 text-center text-sm text-white/70"
      >
        <p>
          {!selected
            ? 'Select an agent to view its phone.'
            : !current
              ? 'Loading this agent’s phone…'
              : 'No active phone interaction for this agent.'}
        </p>
        <p className="text-xs">Phone access requires the connected phone service.</p>
      </div>
    );
  return (
    <PhoneSession
      key={`${selected}:${taskId}`}
      onCompleted={rememberCompleted}
      agentId={selected}
      taskId={taskId}
      messages={messages}
      readOnly={context.inspectionContext != null}
    />
  );
}
