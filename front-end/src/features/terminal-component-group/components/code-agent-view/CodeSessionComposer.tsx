/**
 * STATE MACHINE: CodeSessionComposer (the code-agent view's query box)
 *
 * The existing QueryInput as the session's direct channel, with its existing
 * controls fed by the code agent's own data:
 *   model chip   (ModelSelector) → the model the session runs: the live
 *                  session's effective setting, else its recorded CLI model.
 *                  [LIVE + catalog] pick the next turn's model · [ENDED] read-only
 *   speed toggle (SpeedToggle)   → the session's speed (fast ⇄ standard); live
 *                  sessions change the next turn's speed, ended ones read only
 *   nub          (ContextMeter)  → the session's context window used: the
 *                  latest model call's prompt over the model's window
 *   agents drawer (BackgroundAgentsBannerView, on top of the box) → the code
 *                  agent's own sub-agents (Claude's Task / Agent tool)
 * Unknown values render nothing (no "unavailable" placeholder). A delivery ACK's
 * effective settings replace the catalog's.
 */
import { useEffect, useMemo, useState } from 'react';
import { API_BASE_WITH_PATH, getAuthHeaders } from '@/lib/api/client';
import type { FilePointer } from '@/lib/api/types';
import { useAgentContext, type Model } from '../../hooks';
import { getCodeDraft, setCodeDraft } from '../../hooks/codeAgentLocalState';
import type { DirectTurn } from '../../hooks/codeAgentDirectTurn';
import type { CodeSessionSettings } from '../../hooks/codeSessionSettings';
import QueryInput from '../QueryInput';
import { ContextMeter } from '../query-input/ContextMeter';
import { QueryInfoMenu } from '../query-input/QueryInfoMenu';
import { BackgroundAgentsBannerView } from '../background-agents/BackgroundAgentsBanner';
import { buildCodeSubAgentPanelModel, type CodeSessionState } from './codeSubAgents';
import type { CodeAgentConversation } from './useCodeAgentConversation';

interface Settings {
  model: string;
  effort?: string;
  speed?: string;
}
interface Capabilities {
  effective_settings: Settings;
  models: Array<{ model: string; label: string; efforts: string[]; speeds: string[] }>;
}

const noop = () => {};

/** The live session's catalog (null while unknown, ended or unreachable). */
function useCapabilities(taskId: string, live: boolean): Capabilities | null {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  useEffect(() => {
    if (!live) return;
    let current = true;
    void fetch(
      `${API_BASE_WITH_PATH}/claude-code-session/${encodeURIComponent(taskId)}/capabilities`,
      { headers: getAuthHeaders() },
    )
      .then(async (response) => (response.ok ? ((await response.json()) as Capabilities) : null))
      .then((value) => {
        if (current && value && Array.isArray(value.models) && value.effective_settings)
          setCapabilities(value);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [taskId, live]);
  return live ? capabilities : null;
}

export function CodeSessionComposer({
  c,
  taskId,
  settings,
  turn,
}: {
  c: CodeAgentConversation;
  taskId: string;
  settings: CodeSessionSettings;
  turn: DirectTurn;
}) {
  const [draft, setDraft] = useState(() => getCodeDraft(taskId) ?? { text: '', options: {} });
  const live = c.stateText === 'Running';
  const { messages } = useAgentContext();
  const sessionState: CodeSessionState =
    c.chipState === 'completed' || c.chipState === 'failed' || c.chipState === 'paused'
      ? c.chipState
      : 'running';
  const subAgents = useMemo(
    () => buildCodeSubAgentPanelModel(messages, taskId, sessionState),
    [messages, taskId, sessionState],
  );
  const capabilities = useCapabilities(taskId, live);
  const { send, sending, error, effective } = turn;
  const update = (next: typeof draft) => {
    setCodeDraft(taskId, next);
    setDraft(next);
  };
  const current = {
    model: effective?.model ?? capabilities?.effective_settings.model ?? settings.model,
    speed: effective?.speed ?? capabilities?.effective_settings.speed ?? settings.speed,
  };
  const model = draft.options.model ?? current.model;
  const speed = draft.options.speed ?? current.speed;
  const choices = capabilities?.models.find((item) => item.model === model);
  const models: Model[] = (
    capabilities?.models.map((item) => ({ id: item.model, name: item.label })) ??
    (model ? [{ id: model, name: model }] : [])
  ).map((item) => ({ ...item, provider: c.provider }));
  const canChangeSpeed = !!choices && choices.speeds.includes('fast') && !sending;
  const contextWindow = settings.contextWindow;
  const contextSize = settings.contextTokens ?? 0;
  const contextPercentage = contextWindow ? Math.min(100, (contextSize / contextWindow) * 100) : 0;
  const submit = async (attachments?: FilePointer[]) => {
    const delivered = await send(draft.text, {
      ...draft.options,
      ...(attachments?.length ? { attachments } : {}),
    });
    if (delivered) update({ ...draft, text: '' });
    return delivered;
  };
  return (
    <div data-testid="code-agent-view-composer" className="relative z-10">
      <QueryInput
        liftAboveApps
        directChannel
        draftKey={taskId}
        value={draft.text}
        onChange={(text) => update({ ...draft, text })}
        onSubmit={submit}
        disabled={sending}
        placeholder={`Message ${c.label}…`}
        canSubmit
        topAttachment={
          <BackgroundAgentsBannerView key={taskId} model={subAgents} onNavigate={noop} />
        }
        selectedModel={model}
        availableModels={models}
        showModelSelector={!!capabilities && !sending}
        onModelChange={(next) => update({ ...draft, options: { model: next } })}
        speedControl={
          speed
            ? {
                fastMode: speed !== 'standard',
                onFastModeChange: canChangeSpeed
                  ? (fast) =>
                      update({
                        ...draft,
                        options: { ...draft.options, speed: fast ? 'fast' : 'standard' },
                      })
                  : undefined,
              }
            : undefined
        }
        nub={
          <>
            {contextWindow !== undefined && (
              <ContextMeter
                variant="nub"
                contextPercentage={contextPercentage}
                contextSize={contextSize}
                restartThreshold={contextWindow}
              />
            )}
            <QueryInfoMenu />
          </>
        }
      />
      {error && (
        <p
          role="alert"
          data-testid="code-agent-view-error"
          className="mx-auto mt-1.5 max-w-4xl px-1 text-[13px] text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}
    </div>
  );
}
