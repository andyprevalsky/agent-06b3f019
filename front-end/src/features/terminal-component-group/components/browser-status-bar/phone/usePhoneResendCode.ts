/**
 * STATE MACHINE: Resend code (one per agent + browser task, shared by overlay and inbox card)
 *
 * [IDLE + pending request R] --tap--> [SENDING(R)] --POST rejected--> [IDLE + notice]
 * [SENDING(R)] --agent re-raises a pending request R' != R--> [DONE] --60 s--> [IDLE]
 * [SENDING(R)] --no new request within 3 min--> [IDLE + notice]
 * The tap completes R with a typed resend intent; it never carries user text.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { submitPhoneAuthResendCode } from '@/lib/api/attention';

export const RESEND_COOLDOWN_MS = 60_000;
export const RESEND_CONFIRM_TIMEOUT_MS = 180_000;
type Entry =
  | { phase: 'sending'; requestId: string; at: number }
  | { phase: 'done'; requestId: string; at: number }
  | { phase: 'idle'; notice: string };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const IDLE: Entry = { phase: 'idle', notice: '' };
function set(key: string, entry: Entry) {
  entries.set(key, entry);
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/** Test seam: the store is module-scoped so overlay and inbox share one press. */
export function resetPhoneResendCodeState() {
  entries.clear();
  listeners.forEach((listener) => listener());
}

export function usePhoneResendCode(
  agentId: string | null | undefined,
  taskId: string,
  pendingRequestId: string | null | undefined,
) {
  const key = `${agentId ?? ''}:${taskId}`;
  const entry = useSyncExternalStore(subscribe, () => entries.get(key) ?? IDLE);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (entry.phase === 'sending' && pendingRequestId && pendingRequestId !== entry.requestId)
      set(key, { phase: 'done', requestId: pendingRequestId, at: Date.now() });
  }, [entry, key, pendingRequestId]);
  useEffect(() => {
    if (entry.phase === 'idle') return;
    const limit = entry.phase === 'done' ? RESEND_COOLDOWN_MS : RESEND_CONFIRM_TIMEOUT_MS;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      if (entries.get(key) === entry && current - entry.at >= limit)
        set(key, {
          phase: 'idle',
          notice: entry.phase === 'sending' ? 'Resend not confirmed yet. Check the phone.' : '',
        });
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [entry, key]);
  const press = useCallback(async () => {
    const current = entries.get(key) ?? IDLE;
    if (!agentId || !pendingRequestId || current.phase !== 'idle') return;
    set(key, { phase: 'sending', requestId: pendingRequestId, at: Date.now() });
    const command = new AbortController();
    const timeout = setTimeout(() => command.abort(), 15000);
    try {
      const status = await submitPhoneAuthResendCode(pendingRequestId, command.signal);
      if (status >= 400)
        set(key, { phase: 'idle', notice: 'Resend was not accepted. Check the phone.' });
    } catch {
      /* An uncertain POST stays SENDING until the agent re-asks or the bound expires. */
    } finally {
      clearTimeout(timeout);
    }
  }, [agentId, key, pendingRequestId]);
  return {
    phase: entry.phase,
    notice: entry.phase === 'idle' ? entry.notice : '',
    cooldownSeconds:
      entry.phase === 'done'
        ? Math.max(0, Math.ceil((RESEND_COOLDOWN_MS - (now - entry.at)) / 1000))
        : 0,
    available: entry.phase === 'idle' && !!agentId && !!pendingRequestId,
    active: entry.phase !== 'idle',
    press,
  };
}
