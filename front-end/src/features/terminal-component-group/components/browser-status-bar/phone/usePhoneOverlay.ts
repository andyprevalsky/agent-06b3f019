/**
 * [DORMANT] --owned phone event + visible--> [READ] -> [WAITING|ACTIVE|CLOSED]
 * [WAITING|ACTIVE] --sequential bounded poll--> [READ]; CLOSED stops polling.
 * [ACTIVE_AGENT] --confirmed control(user) + fresh bounds--> [ACTIVE_USER]
 * [ACTIVE_USER] --command(UUID,cursor)--> [PENDING] --status reads only--> [USER|UNKNOWN]
 * UNKNOWN blocks writes, never replays input. Handback confirms control(agent).
 * [DORMANT] owns no visibility listener, timer or request.
 * hide/task change -> abort scope + revoke private frame; show -> fresh scope/read/bounds.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  controlPhone,
  PhoneRequestError,
  readPhoneFrame,
  readPhoneInteraction,
  readPhoneOperation,
} from '@/lib/api/iphone';
import type { PhoneAttention } from '@/lib/api/phoneAttention';
import { phoneVerificationPending } from './phoneStatus';
import { phoneLeaseVisible, readPointBounds } from './phoneOverlayState';
import { emptyView, phoneScopeCanWrite, type Scope, type View } from './phoneOverlaySession';
import { performScopedPhoneOperation, recordPhoneOutcome } from './phoneOverlayOperations';

export function usePhoneOverlay(
  taskId: string,
  trigger: string,
  readOnly: boolean,
  attention?: PhoneAttention | null,
  expectedAgentId?: string,
) {
  const attentionRef = useRef(attention);
  attentionRef.current = attention;
  const [view, setView] = useState<View>(() => emptyView(taskId));
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const scopeRef = useRef<Scope | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const latestTrigger = useRef(trigger);
  latestTrigger.current = trigger;
  const enabled = !!trigger;
  const publish = useCallback((scope: Scope, error?: string) => {
    if (scope.controller.signal.aborted || scopeRef.current !== scope) return;
    setView((previous) => ({
      taskId: scope.taskId,
      notice: scope.notice,
      snapshot: scope.snapshot,
      frame: scope.frame,
      bounds: scope.bounds,
      busy: scope.action,
      queueTimedOut: scope.queued && scope.snapshot?.lease?.status === 'EXPIRED',
      error: error ?? previous.error,
      uncertain:
        scope.operation !== null &&
        scope.operation.status !== 'SUCCEEDED' &&
        scope.operation.status !== 'FAILED',
    }));
  }, []);
  const refresh = useCallback(
    async (scope: Scope) => {
      scope.attention = attentionRef.current;
      const snapshot = await readPhoneInteraction(scope.taskId, scope.controller.signal);
      if (scope.controller.signal.aborted) return;
      if (
        snapshot.lease &&
        (snapshot.lease.browserTaskId !== scope.taskId ||
          (expectedAgentId !== undefined && snapshot.lease.agentId !== expectedAgentId))
      ) {
        scope.blocked = true;
        throw new Error('Phone task mismatch');
      }
      if (
        snapshot.lease?.id !== scope.snapshot?.lease?.id ||
        snapshot.lease?.controlOwner !== scope.snapshot?.lease?.controlOwner ||
        snapshot.lease?.attentionRequestId !== scope.snapshot?.lease?.attentionRequestId
      ) {
        scope.bounds = null;
        scope.boundsAt = 0;
        scope.operation = null;
      }
      if (snapshot.lease?.id !== scope.snapshot?.lease?.id) scope.queued = false;
      if (snapshot.lease?.status === 'WAITING') scope.queued = true;
      scope.snapshot = snapshot;
      if (!phoneLeaseVisible(snapshot.lease)) {
        if (scope.frame) URL.revokeObjectURL(scope.frame);
        scope.frame = null;
        scope.bounds = null;
        scope.operation = null;
      }
      if (
        snapshot.pendingOperation &&
        (!scope.operation || ['SUCCEEDED', 'FAILED'].includes(scope.operation.status))
      )
        scope.operation = snapshot.pendingOperation;
      publish(scope);
    },
    [expectedAgentId, publish],
  );
  const operation = useCallback(
    (scope: Scope, name: string, args: Record<string, unknown>) =>
      performScopedPhoneOperation(scope, name, args, publish),
    [publish],
  );
  const loadBounds = useCallback(
    async (scope: Scope) => {
      scope.bounds = null;
      const result = await operation(scope, 'screen.bounds', {});
      if (result?.status === 'SUCCEEDED') {
        scope.bounds = readPointBounds(result.result);
        scope.boundsAt = Date.now();
      }
      publish(scope);
    },
    [operation, publish],
  );
  useEffect(() => {
    if (!enabled) return;
    const changed = () => setVisible(document.visibilityState !== 'hidden');
    changed();
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, [enabled]);
  useEffect(() => {
    setView(emptyView(taskId));
    if (!enabled || !visible || document.visibilityState === 'hidden') return;
    const scope: Scope = {
      taskId,
      attention: attentionRef.current,
      notice: '',
      controller: new AbortController(),
      snapshot: null,
      frame: null,
      bounds: null,
      boundsAt: 0,
      action: false,
      polling: null,
      operation: null,
      queued: false,
      bootstrapReads: 0,
      blocked: false,
      stopped: false,
      trigger: latestTrigger.current,
    };
    scopeRef.current = scope;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (scope.controller.signal.aborted) return;
      if (scope.action) {
        timer = setTimeout(() => void tick(), 1000);
        return;
      }
      const poll = async () => {
        try {
          scope.trigger = latestTrigger.current;
          if (!scope.snapshot?.lease) scope.bootstrapReads++;
          await refresh(scope);
          const lease = scope.snapshot?.lease;
          if (
            scope.operation &&
            !['SUCCEEDED', 'FAILED'].includes(scope.operation.status) &&
            lease
          ) {
            const pending = await readPhoneOperation(
              lease.id,
              scope.operation.id,
              scope.controller.signal,
            );
            if (pending.operation.id !== scope.operation.id)
              throw new Error('Phone operation scope mismatch');
            recordPhoneOutcome(scope, pending.operation);
            if (
              pending.operation.operation === 'screen.bounds' &&
              pending.operation.status === 'SUCCEEDED'
            ) {
              scope.bounds = readPointBounds(pending.operation.result);
              scope.boundsAt = Date.now();
            }
          }
          if (phoneVerificationPending(scope.operation)) {
            if (scope.frame) URL.revokeObjectURL(scope.frame);
            scope.frame = null;
            scope.bounds = null;
          } else if (lease?.status === 'ACTIVE') {
            if (
              !readOnly &&
              lease.controlOwner === 'user' &&
              phoneScopeCanWrite(scope) &&
              (!scope.operation || ['SUCCEEDED', 'FAILED'].includes(scope.operation.status)) &&
              (!scope.bounds || Date.now() - scope.boundsAt > 15000)
            )
              await loadBounds(scope);
            const blob = await readPhoneFrame(lease.id, scope.controller.signal);
            if (scope.controller.signal.aborted) return;
            const next = URL.createObjectURL(blob);
            if (scope.frame) URL.revokeObjectURL(scope.frame);
            scope.frame = next;
          } else if (scope.frame) {
            URL.revokeObjectURL(scope.frame);
            scope.frame = null;
            scope.bounds = null;
          }
          publish(
            scope,
            !lease && scope.bootstrapReads >= 3
              ? 'Phone connection unavailable. Refresh phone view to reconnect.'
              : '',
          );
        } catch (error) {
          if (error instanceof PhoneRequestError && [403, 404].includes(error.status))
            scope.blocked = true;
          scope.bounds = null;
          if (scope.frame) {
            URL.revokeObjectURL(scope.frame);
            scope.frame = null;
          }
          if (!scope.controller.signal.aborted)
            publish(
              scope,
              error instanceof PhoneRequestError && error.status === 409
                ? 'Phone state changed. Refreshing; no input was replayed.'
                : 'Phone view temporarily unavailable.',
            );
        }
      };
      scope.polling = poll();
      await scope.polling;
      scope.polling = null;
      scope.stopped = true;
      if (!scope.controller.signal.aborted && !scope.blocked) {
        if (phoneLeaseVisible(scope.snapshot?.lease)) {
          scope.stopped = false;
          timer = setTimeout(() => void tick(), 1000);
        } else if (!scope.snapshot?.lease && scope.bootstrapReads < 3) {
          scope.stopped = false;
          timer = setTimeout(() => void tick(), 1000 * 2 ** Math.max(0, scope.bootstrapReads - 1));
        }
      }
      if (
        !scope.controller.signal.aborted &&
        scope.stopped &&
        scope.trigger !== latestTrigger.current
      )
        setRefreshVersion((version) => version + 1);
    };
    void tick();
    return () => {
      scope.controller.abort();
      clearTimeout(timer);
      if (scope.frame) URL.revokeObjectURL(scope.frame);
      if (scopeRef.current === scope) scopeRef.current = null;
    };
  }, [loadBounds, publish, readOnly, refresh, taskId, enabled, visible, refreshVersion]);
  useEffect(() => {
    const scope = scopeRef.current;
    if (trigger && scope?.stopped && scope.trigger !== trigger)
      setRefreshVersion((version) => version + 1);
  }, [trigger]);
  const act = useCallback(
    async (
      mode: 'user' | 'agent' | null,
      name?: string,
      args: Record<string, unknown> = {},
      expectedAttentionId?: string,
    ) => {
      const scope = scopeRef.current;
      if (!scope || scope.controller.signal.aborted || readOnly || scope.action) return;
      scope.action = true;
      publish(scope);
      try {
        await scope.polling;
        const lease = scope.snapshot?.lease;
        scope.attention = attentionRef.current;
        if (
          scope.controller.signal.aborted ||
          scope !== scopeRef.current ||
          !phoneScopeCanWrite(scope) ||
          (lease?.attentionRequestId && expectedAttentionId !== lease.attentionRequestId)
        )
          return;
        if (lease?.status !== 'ACTIVE') return;
        if (mode) {
          if (lease.attentionRequestId) return;
          scope.bounds = null;
          const result = await controlPhone(lease.id, mode, scope.controller.signal);
          if (result.lease.controlOwner !== mode) throw new Error('Control transition unconfirmed');
          await refresh(scope);
          if (mode === 'user') await loadBounds(scope);
        } else {
          if (
            lease.controlOwner !== 'user' ||
            !scope.bounds ||
            Date.now() - scope.boundsAt > 15000 ||
            (scope.operation && !['SUCCEEDED', 'FAILED'].includes(scope.operation.status))
          )
            return;
          scope.bounds = null;
          await operation(scope, name, args);
          await refresh(scope);
          if (scope.operation?.status === 'SUCCEEDED' || scope.operation?.status === 'FAILED')
            await loadBounds(scope);
        }
      } catch (error) {
        if (!scope.controller.signal.aborted)
          publish(
            scope,
            error instanceof PhoneRequestError && error.status === 409
              ? 'Phone state changed. Refreshing; no input was replayed.'
              : 'Phone action unconfirmed. Checking its status; input will not be replayed.',
          );
      } finally {
        scope.action = false;
        publish(scope);
      }
    },
    [loadBounds, operation, publish, readOnly, refresh],
  );
  const invalidateBounds = useCallback(() => {
    const scope = scopeRef.current;
    if (scope) {
      scope.bounds = null;
      scope.boundsAt = 0;
      publish(scope);
    }
  }, [publish]);
  return {
    ...(view.taskId === taskId && visible ? view : emptyView(taskId)),
    visible: visible && view.taskId === taskId && phoneLeaseVisible(view.snapshot?.lease),
    control: (mode: 'user' | 'agent') => act(mode),
    input: (name: string, args: Record<string, unknown>) => act(null, name, args, attention?.id),
    invalidateBounds,
    refreshView: () => setRefreshVersion((version) => version + 1),
  };
}
export type PhoneOverlayModel = ReturnType<typeof usePhoneOverlay>;
