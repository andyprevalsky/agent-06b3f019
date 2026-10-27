/** Native settings come from the provider catalog; only a delivery ACK confirms them. */
import { useEffect, useState } from 'react';
import { API_BASE_WITH_PATH, getAuthHeaders } from '@/lib/api/client';
import type { FilePointer } from '@/lib/api/types';
import { getCodeDraft, setCodeDraft } from '../../hooks/codeAgentLocalState';
import { useDirectTurn } from '../../hooks/codeAgentDirectTurn';
import type { CodeTurnOptions } from '../../hooks/codeAgentContract';
import QueryInput from '../QueryInput';
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

export function CodeSessionComposer({ c, taskId }: { c: CodeAgentConversation; taskId: string }) {
  const [draft, setDraft] = useState(() => getCodeDraft(taskId) ?? { text: '', options: {} });
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [loadError, setLoadError] = useState(false);
  const { send, sending, error, effective } = useDirectTurn(taskId, c.toolCallId);
  const update = (next: typeof draft) => {
    setCodeDraft(taskId, next);
    setDraft(next);
  };
  useEffect(() => {
    let live = true;
    void fetch(
      `${API_BASE_WITH_PATH}/claude-code-session/${encodeURIComponent(taskId)}/capabilities`,
      { headers: getAuthHeaders() },
    )
      .then(async (response) => {
        if (!response.ok) throw Error('Unavailable');
        return (await response.json()) as Capabilities;
      })
      .then((value) => {
        if (live && Array.isArray(value.models) && value.effective_settings) setCapabilities(value);
      })
      .catch(() => {
        if (live) setLoadError(true);
      });
    return () => {
      live = false;
    };
  }, [taskId]);
  const acknowledged = effective
    ? { model: effective.model, effort: effective.reasoning_effort, speed: effective.speed }
    : capabilities?.effective_settings;
  const model = draft.options.model ?? capabilities?.effective_settings.model;
  const choices = capabilities?.models.find((item) => item.model === model);
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
        showModelSelector={false}
        canSubmit
        sessionControls={
          capabilities && (
            <div className="flex flex-wrap gap-2 text-xs">
              <label>
                Model{' '}
                <select
                  aria-label="Code model"
                  disabled={sending}
                  value={model}
                  onChange={(event) => update({ ...draft, options: { model: event.target.value } })}
                >
                  {capabilities.models.map((item) => (
                    <option key={item.model} value={item.model}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              {!!choices?.efforts.length && (
                <label>
                  Effort{' '}
                  <select
                    aria-label="Reasoning effort"
                    disabled={sending}
                    value={draft.options.reasoning_effort ?? ''}
                    onChange={(event) =>
                      update({
                        ...draft,
                        options: {
                          ...draft.options,
                          reasoning_effort: event.target.value || undefined,
                        },
                      })
                    }
                  >
                    <option value="">Session default</option>
                    {choices.efforts.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
              )}
              {!!choices?.speeds.length && (
                <label>
                  Speed{' '}
                  <select
                    aria-label="Code speed"
                    disabled={sending}
                    value={draft.options.speed ?? ''}
                    onChange={(event) =>
                      update({
                        ...draft,
                        options: { ...draft.options, speed: event.target.value || undefined },
                      })
                    }
                  >
                    <option value="">Session default</option>
                    {choices.speeds.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )
        }
      />
      {acknowledged && (
        <p role="status" className="mx-auto mt-1 max-w-4xl text-xs text-muted-foreground">
          Effective:{' '}
          {[acknowledged.model, acknowledged.effort, acknowledged.speed]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {loadError && (
        <p className="mx-auto mt-1 max-w-4xl text-xs text-muted-foreground">
          Session settings unavailable
        </p>
      )}
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
