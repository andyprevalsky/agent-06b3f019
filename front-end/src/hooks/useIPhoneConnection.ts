/**
 * STATE MACHINE: useIPhoneConnection (shared by the Integrations row and the Phone app)
 *
 *   [LOADING] --GET /iphone/connection--> [not_connected|setting_up|ready|needs_reauth]
 *   [not_connected|needs_reauth] --connect() POST /iphone/connect--> [setting_up]
 *   [setting_up] polls /connection every SETUP_POLL_MS (setupProgress steps fill)
 *     --server reports ready--> [ready] (fast poll stops; slow 30 s status poll only)
 *   window focus --> one fresh read. Only the server can declare readiness.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { connectIPhone, readIPhoneConnection, type IPhoneConnection } from '@/lib/api/iphone';

/** Setup-progress cadence: cheap persisted status, never the physical provider. */
export const IPHONE_SETUP_POLL_MS = 2_500;
const IPHONE_STATUS_POLL_MS = 30_000;

/** Only the server can declare readiness; ordinary Integrations never sees a provider grant. */
export function useIPhoneConnection() {
  const [status, setStatus] = useState<IPhoneConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const reading = useRef<Promise<IPhoneConnection | null> | null>(null);
  const connecting = useRef(false);
  const requestKey = useRef<string | null>(null);

  const refresh = useCallback((): Promise<IPhoneConnection | null> => {
    if (reading.current !== null) return reading.current;
    const owned = new AbortController();
    controller.current = owned;
    const read = (async () => {
      try {
        const next = await readIPhoneConnection(owned.signal);
        if (live.current && !owned.signal.aborted) {
          setStatus((previous) =>
            previous !== null && previous.connectionRevision > next.connectionRevision
              ? previous
              : next,
          );
          setError(null);
        }
        return next;
      } catch {
        if (live.current && !owned.signal.aborted) setError('Unable to load iPhone connection.');
        return null;
      } finally {
        if (reading.current === read) reading.current = null;
        if (controller.current === owned) controller.current = null;
      }
    })();
    reading.current = read;
    return read;
  }, []);

  useEffect(() => {
    live.current = true;
    void refresh();
    const focus = () => {
      if (!connecting.current) void refresh();
    };
    window.addEventListener('focus', focus);
    return () => {
      live.current = false;
      controller.current?.abort();
      reading.current = null;
      window.removeEventListener('focus', focus);
    };
  }, [refresh]);

  useEffect(() => {
    if (busy || !status?.enabled || !status.configured) return undefined;
    // Cheap persisted status only; this never polls the physical provider.
    const timer = setInterval(
      () => void refresh(),
      status.status === 'setting_up' ? IPHONE_SETUP_POLL_MS : IPHONE_STATUS_POLL_MS,
    );
    return () => clearInterval(timer);
  }, [busy, refresh, status]);

  /** Resolves with the server's accepted connection, or null when nothing was started. */
  const connect = useCallback(async (): Promise<IPhoneConnection | null> => {
    if (connecting.current) return null;
    connecting.current = true;
    setBusy(true);
    setError(null);
    try {
      const current = await refresh();
      if (
        !live.current ||
        current === null ||
        !current.enabled ||
        !current.configured ||
        current.status === 'ready'
      )
        return null;
      const owned = new AbortController();
      controller.current = owned;
      requestKey.current ??= crypto.randomUUID();
      const next = await connectIPhone(
        requestKey.current,
        current.connectionRevision,
        owned.signal,
      );
      if (live.current && !owned.signal.aborted) {
        setStatus((previous) =>
          previous !== null && previous.connectionRevision > next.connectionRevision
            ? previous
            : next,
        );
        requestKey.current = null;
        return next;
      }
      return null;
    } catch {
      if (live.current) setError('Unable to connect iPhone. Try again.');
      return null;
    } finally {
      connecting.current = false;
      if (live.current) setBusy(false);
    }
  }, [refresh]);
  return { status, busy, error, connect };
}
