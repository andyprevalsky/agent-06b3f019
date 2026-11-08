/**
 * STATE MACHINE: CodeSessionComposer (the code-agent view's query box)
 *
 * The existing QueryInput as the session's direct channel, with its existing
 * controls fed by the code agent's own data:
 *   model chip   (ModelSelector) → the model the session runs, with its effort
 *                  ("claude-opus-5-5 · xhigh"): the live session's effective
 *                  setting, else its recorded CLI model.
 *                  [LIVE + catalog] pick the next turn's model · [ENDED] read-only
 *   speed toggle (SpeedToggle)   → the session's exact speed (standard / fast —
 *                  Codex's `priority` tier — / ultrafast, never the account's
 *                  fast-vs-ultra preference); live sessions cycle the next turn's
 *                  speed through the model's own speed ids, ended ones read only
 *   newest run (c.liveTaskId)    → a resumed agent's catalog, usage and container
 *                  are its newest run's, never the original task's
 *   top-right corner (cornerStatus) → CodeContainerStatus (green awake, slow
 *                  fade · orange stopped · red destroyed, tooltip) + the devbox
 *                  usage bars (CodeResourcesIndicator, always shown; its popover
 *                  holds the session's "Open app" preview link)
 *   nub          (never an empty strip) → ContextMeter: the latest model call's
 *                  prompt over the model's window (the tokens when the window is
 *                  not known yet) + the existing Agent settings gear, fed by this
 *                  code agent's own data (messages, tokens, sandbox cost, context)
 *   agents drawer (BackgroundAgentsBannerView, on top of the box) → the code
 *                  agent's own sub-agents (Claude's Task / Agent tool)
 * Unknown values render nothing (no "unavailable" placeholder). A delivery ACK's
 * effective settings replace the catalog's.
 */
import { useEffect, useMemo, useState } from 'react';
import { nextSpeedLevel, type SpeedLevel } from '@/lib/agentSpeed';
import { API_BASE_WITH_PATH, getAuthHeaders } from '@/lib/api/client';
import type { FilePointer } from '@/lib/api/types';
import { useAgentContext, type Model } from '../../hooks';
import { getCodeDraft, setCodeDraft } from '../../hooks/codeAgentLocalState';
import type { DirectTurn } from '../../hooks/codeAgentDirectTurn';
import type { CodeSessionSettings } from '../../hooks/codeSessionSettings';
import QueryInput from '../QueryInput';
import AgentSettingsDialog from '../AgentSettingsDialog';
import { ContextMeter } from '../query-input/ContextMeter';
import { QueryInfoMenu } from '../query-input/QueryInfoMenu';
import { BackgroundAgentsBannerView } from '../background-agents/BackgroundAgentsBanner';
import { CodeResourcesIndicator } from '../CodeResourcesIndicator';
import { useCachedCodeAgent } from '../rose-sidebar/useRoseCodeAgents';
import { CodeContainerStatus } from './CodeContainerStatus';
import { codeContainerState } from './codeContainerState';
import { codeAgentDetail } from './codeAgentDetail';
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

/** A session's reported speed → the toggle's level (Codex reports fast as `priority`). */
const SPEED_LEVEL: Record<string, SpeedLevel> = {
  standard: 'normal',
  fast: 'fast',
  priority: 'fast',
  ultrafast: 'ultra',
};

/** The model's own speed id for a level, first listed wins (Codex's fast tier is `priority`). */
const LEVEL_SPEED_IDS: Record<SpeedLevel, string[]> = {
  normal: ['standard'],
  fast: ['fast', 'priority'],
  ultra: ['ultrafast'],
};

function speedIdFor(level: SpeedLevel, speeds: string[]): string | null {
  const id = LEVEL_SPEED_IDS[level].find((candidate) => speeds.includes(candidate));
  return id ?? (level === 'normal' ? 'standard' : null);
}

/** The next level after `level` the model supports, with its speed id (null: none other). */
function nextSupportedSpeed(
  level: SpeedLevel,
  speeds: string[],
): { level: SpeedLevel; id: string } | null {
  let next = nextSpeedLevel(level);
  while (next !== level) {
    const id = speedIdFor(next, speeds);
    if (id) return { level: next, id };
    next = nextSpeedLevel(next);
  }
  return null;
}

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
  // A resumed agent runs under a new task id: live state, catalog, usage and
  // container all belong to that newest run (c.liveTaskId).
  const capabilities = useCapabilities(c.liveTaskId, live);
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
  const effort =
    effective?.reasoning_effort ?? capabilities?.effective_settings.effort ?? settings.effort;
  // The chip names the model and its effort; the provider is the code agent's own.
  const named = (id: string, label: string) => ({
    id,
    name: id === model && effort ? `${label} · ${effort}` : label,
    provider: '',
  });
  const models: Model[] =
    capabilities?.models.map((item) => named(item.model, item.label)) ??
    (model ? [named(model, model)] : []);
  const level = speed ? SPEED_LEVEL[speed] : undefined;
  const nextSpeed = level && choices && !sending ? nextSupportedSpeed(level, choices.speeds) : null;
  const container = codeContainerState(c.meta, useCachedCodeAgent(c.liveTaskId));
  const contextWindow = settings.contextWindow;
  const contextSize = settings.contextTokens ?? 0;
  const contextPercentage = contextWindow ? Math.min(100, (contextSize / contextWindow) * 100) : 0;
  const owner = useAgentContext();
  const agentDetail = useMemo(
    () =>
      codeAgentDetail(
        taskId,
        owner.selectedAgentId ?? '',
        c,
        { ...settings, model, speed },
        new Date(0).toISOString(),
        messages.filter((message) => message.metadata?.task_id === taskId).length,
      ),
    [taskId, owner.selectedAgentId, c, settings, model, speed, messages],
  );
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
          level
            ? {
                fastMode: level !== 'normal',
                level,
                onLevelChange: nextSpeed
                  ? () => update({ ...draft, options: { ...draft.options, speed: nextSpeed.id } })
                  : undefined,
              }
            : undefined
        }
        cornerStatus={
          <>
            <CodeContainerStatus state={container} />
            <CodeResourcesIndicator
              taskId={c.liveTaskId}
              running={live}
              persistent
              preview={
                c.meta?.preview_url
                  ? {
                      previewUrl: c.meta.preview_url,
                      title: c.meta.title ?? null,
                      provider: c.provider,
                    }
                  : undefined
              }
            />
          </>
        }
        nub={
          <>
            {settings.contextTokens !== undefined && (
              <ContextMeter
                variant="nub"
                contextPercentage={contextPercentage}
                contextSize={contextSize}
                restartThreshold={contextWindow ?? 0}
              />
            )}
            <AgentSettingsDialog variant="nub" agent={agentDetail} contextWindow={contextWindow} />
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
