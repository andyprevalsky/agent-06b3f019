/** Only the open Phone app mounts an exact selected-agent scoped reader. */
import { useContext } from 'react';
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
}: {
  agentId: string;
  taskId: string;
  messages: Message[];
  readOnly: boolean;
}) {
  const attention = usePhoneAttention(taskId, agentId, messages, readOnly);
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
      {!phone.visible && attention.error && (
        <PhoneAttentionNotice attention={attention} lease={phone.snapshot?.lease} />
      )}
      <PhoneOverlay phone={phone} readOnly={readOnly} attention={attention} />
      {!phone.visible && !phone.error && !phone.queueTimedOut && !attention.error && (
        <p role="status" className="m-auto px-6 text-center text-sm text-white/70">
          Checking this agent’s phone connection…
        </p>
      )}
    </div>
  );
}
export function PhoneAppScreen() {
  const apps = useRoseApps();
  const context = useContext(AgentContext);
  const agent = context?.agent;
  const selected = apps?.selectedAgentId;
  const current =
    selected &&
    context?.selectedAgentId === selected &&
    agent?.agent_id === selected &&
    !context.isLoadingAgent;
  const messages = current ? context.messages : [];
  const taskId = current ? phoneAppTarget(selected, messages, apps.tabs) : null;
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
      agentId={selected}
      taskId={taskId}
      messages={messages}
      readOnly={context.inspectionContext != null}
    />
  );
}
