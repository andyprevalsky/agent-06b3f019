/**
 * [CANDIDATE] -> authenticated exact lookup -> [PENDING|STALE|UNAVAILABLE].
 * [COMPLETE ONCE] -> read until acknowledged; lost response never replays a mutation.
 * [NO CANDIDATE] -> no phone visibility subscription or requests.
 * Hide aborts observations; backend owns the reservation. Completion means verify, not setup-ready.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AuthAssistanceReadError,
  readAuthAssistanceRequest,
  submitPhoneAuthCompletion,
} from '@/lib/api/attention';
import { readPhoneAttention, type PhoneAttention } from '@/lib/api/phoneAttention';
import { getQueryParams } from '@/lib/url';
import { phoneAttentionCandidate } from './phoneAttentionState';
import type { Message } from '../../../hooks';
interface State {
  key: string;
  request: PhoneAttention | null;
  error: string;
  completing: boolean;
  notice?: string;
}
export function usePhoneAttention(
  taskId: string,
  agentId: string | null | undefined,
  messages: Message[],
  readOnly: boolean,
  observe = true,
) {
  const [completed, setCompleted] = useState<PhoneAttention | null>(null);
  const receipt =
    completed?.agentId === agentId && completed.target.browserTaskId === taskId ? completed : null;
  const id = phoneAttentionCandidate(taskId, agentId, messages, receipt?.id);
  useEffect(() => {
    setCompleted(null);
  }, [agentId, taskId]);
  const key = `${agentId ?? ''}:${taskId}:${id}:${readOnly}`;
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const enabled = !!id;
  useEffect(() => {
    if (!enabled) return;
    const changed = () => setVisible(document.visibilityState !== 'hidden');
    changed();
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, [enabled]);
  const [state, setState] = useState<State>({ key, request: null, error: '', completing: false });
  const scope = useRef<{
    key: string;
    controller: AbortController;
    read: () => Promise<void>;
    completing: boolean;
    notice: string;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const owned = { key, controller, read: async () => {}, completing: false, notice: '' };
    scope.current = owned;
    setState({ key, request: null, error: '', completing: false });
    if (!id || !agentId || !visible) return () => controller.abort();
    let timer: ReturnType<typeof setTimeout>,
      running = false,
      failures = 0;
    const read = async () => {
      if (controller.signal.aborted || running || document.visibilityState === 'hidden') return;
      running = true;
      clearTimeout(timer);
      try {
        const result = await readAuthAssistanceRequest(id, controller.signal);
        if (controller.signal.aborted) return;
        failures = 0;
        const request = readPhoneAttention(result.request);
        const valid =
          request?.id === id &&
          request.agentId === agentId &&
          request.target.browserTaskId === taskId;
        setState({
          key,
          request: valid ? request : null,
          error: valid
            ? ''
            : 'This phone authentication request is stale or does not match this task.',
          completing: owned.completing && !request?.completedAt,
          notice: owned.notice,
        });
        if (valid && request.completedAt !== null) {
          const query = getQueryParams();
          if (
            query.get('agent-id') === agentId &&
            query.get('browser-id') === taskId &&
            query.get('attention-request-id') === id
          ) {
            const url = new URL(window.location.href);
            url.searchParams.delete('attention-request-id');
            window.history.replaceState({}, '', url.toString());
          }
          setCompleted(request);
        }
        if (observe && valid && request.completedAt === null)
          timer = setTimeout(() => void read(), 2000);
      } catch (error) {
        if (!controller.signal.aborted)
          setState({
            key,
            request: null,
            completing: owned.completing,
            error: 'Phone authentication request unavailable. Reopen this exact request to retry.',
          });
        if (
          !controller.signal.aborted &&
          ++failures < 3 &&
          !(error instanceof AuthAssistanceReadError && [401, 403, 404].includes(error.status))
        )
          timer = setTimeout(() => void read(), failures * 1000);
      } finally {
        running = false;
      }
    };
    owned.read = read;
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
      if (scope.current === owned) scope.current = null;
    };
  }, [agentId, id, key, taskId, visible, observe]);
  const complete = useCallback(async () => {
    const owned = scope.current;
    if (
      !owned ||
      owned.key !== key ||
      owned.controller.signal.aborted ||
      owned.completing ||
      readOnly ||
      state.key !== key ||
      !state.request ||
      state.request.completedAt !== null
    )
      return;
    owned.completing = true;
    owned.notice = '';
    setState((previous) => ({ ...previous, completing: true }));
    const command = new AbortController();
    const abort = () => command.abort();
    owned.controller.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 15000);
    try {
      const status = await submitPhoneAuthCompletion(id, command.signal);
      if ([400, 401, 403, 404, 409, 422].includes(status)) {
        owned.completing = false;
        owned.notice =
          'Authentication completion was rejected. Check the phone before trying again.';
      }
    } catch {
      /* An uncertain completion is reconciled by its exact request, never by POST replay. */
    } finally {
      clearTimeout(timeout);
      owned.controller.signal.removeEventListener('abort', abort);
      await owned.read();
    }
  }, [id, key, readOnly, state]);
  return {
    id,
    request: id ? (state.key === key ? state.request : null) : receipt,
    error:
      !id && getQueryParams().has('attention-request-id')
        ? 'Phone authentication link does not match this agent or task.'
        : state.key === key
          ? state.error
          : '',
    notice: state.key === key ? (state.notice ?? '') : '',
    completing: state.key === key && state.completing,
    complete,
  };
}
export type PhoneAttentionModel = ReturnType<typeof usePhoneAttention>;
