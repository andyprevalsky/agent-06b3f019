/**
 * Multi-account Claude / Codex connection state.
 *
 * State machine
 * -------------
 *                    ┌────────────────────────────────────────────┐
 *                    ▼                                            │
 *   [idle] ──click Connect──> [starting] ──ok──> [signing_in] ────┤
 *      ▲                          │                   │           │
 *      │                          │ error             │ poll      │
 *      │                          ▼                   ▼           │
 *      └────────────────────── [error] <──expired── (connected) ──┘
 *                                                   refresh chips
 *
 *   [signing_in] --cancel/unmount--> releases the remote browser --> [idle]
 *   [signing_in] --poll names passkeyUnavailableFor--> [signing_in] + passkey notice
 *
 * Usage freshness (while mounted): refetch the list every 60s while the tab is
 * visible, on window focus / visibilitychange, and once the earliest shown
 * cooldown or window reset passes; `now` ticks every 30s so an expired
 * cooldown flips without a round-trip. Background refetches are fire-and-forget:
 * a failure keeps the last list and shows no error.
 *
 * Overlapping list requests (each numbered when it starts):
 *   success → applied unless a newer request's success is already shown
 *             (newest success wins, whatever order responses arrive in)
 *   failure → foreground only, and only if no newer request has succeeded;
 *             a newer success clears an error an older request set
 *
 * Lives in the hooks layer because it owns the API calls; the components layer
 * may not reach into `../api` directly.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  cancelComputeConnect,
  fetchComputeAccounts,
  pollComputeConnect,
  removeComputeAccount,
  startComputeConnect,
  type ComputeAccount,
} from '../api';

type Phase = 'idle' | 'starting' | 'signing_in' | 'error';

const POLL_INTERVAL_MS = 2_000;
const USAGE_REFRESH_MS = 60_000;
const USAGE_TICK_MS = 30_000;

/**
 * Earliest moment after `after` at which a shown state changes on its own: a
 * cooldown ends or a window resets. Null when none is pending.
 */
function nextUsageDeadline(
  accounts: readonly ComputeAccount[],
  after: number = Date.now(),
): number | null {
  let earliest: number | null = null;
  for (const account of accounts) {
    const times = [
      account.cooldown === undefined ? account.rateLimitedUntil : account.cooldown?.until,
      account.nextResetAt,
      account.usage?.sevenDay?.resetsAt,
      account.usage?.fiveHour?.resetsAt,
    ];
    for (const time of times) {
      const at = time == null ? NaN : Date.parse(time);
      if (Number.isFinite(at) && at > after && (earliest === null || at < earliest)) earliest = at;
    }
  }
  return earliest;
}

const tabVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

export function useComputeAccounts(provider: string) {
  const [accounts, setAccounts] = useState<ComputeAccount[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [liveViewUrl, setLiveViewUrl] = useState<string | null>(null);
  const [passkeyUnavailableFor, setPasskeyUnavailableFor] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [connectingAs, setConnectingAs] = useState<string | null>(null);
  // Bumped on every connect attempt. The progress bar keys off this so
  // reopening the modal restarts the bar: without it the first stage is
  // `creating_browser` again, the band is unchanged, and the reset effect never
  // re-runs -- so the bar resumes wherever the previous attempt left it.
  const [runId, setRunId] = useState(0);
  const [removing, setRemoving] = useState<string | null>(null);
  const connectIdRef = useRef<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mountedRef = useRef(true);
  const fetchSeqRef = useRef(0);
  // Number of the request whose list is shown, and of the one that set the error.
  const appliedSeqRef = useRef(0);
  const errorSeqRef = useRef<number | null>(null);
  const lastFetchAtRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // `quiet` = a background refetch: a failure keeps the last list, no error text.
  const refresh = useCallback(
    async (quiet = false) => {
      const seq = ++fetchSeqRef.current;
      lastFetchAtRef.current = Date.now();
      try {
        const next = await fetchComputeAccounts(provider);
        // A newer success is already shown; an older one never replaces it, but a
        // newer request still in flight (or failing later) does not discard this one.
        if (!mountedRef.current || seq < appliedSeqRef.current) return;
        appliedSeqRef.current = seq;
        setAccounts(next);
        setNow(Date.now());
        if (errorSeqRef.current !== null && errorSeqRef.current < seq) {
          errorSeqRef.current = null;
          setError(null);
        }
      } catch (err) {
        if (quiet || !mountedRef.current || seq < appliedSeqRef.current) return;
        errorSeqRef.current = seq;
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [provider],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Usage freshness; see the header.
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;
  useEffect(() => {
    const background = () => {
      if (tabVisible()) void refresh(true).catch(() => undefined);
    };
    const poll = setInterval(background, USAGE_REFRESH_MS);
    const tick = setInterval(() => {
      const at = Date.now();
      setNow(at);
      const deadline = nextUsageDeadline(accountsRef.current, lastFetchAtRef.current);
      if (deadline !== null && deadline <= at) background();
    }, USAGE_TICK_MS);
    const onVisibility = () => {
      if (tabVisible()) background();
    };
    window.addEventListener('focus', background);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      window.removeEventListener('focus', background);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  // Refetch as soon as the earliest shown deadline passes (the tick is the backstop).
  useEffect(() => {
    const deadline = nextUsageDeadline(accounts);
    if (deadline === null) return;
    const delay = deadline - Date.now() + 1_000;
    if (delay > USAGE_REFRESH_MS) return; // the 60s poll gets there first
    const timer = setTimeout(() => {
      if (tabVisible()) void refresh(true).catch(() => undefined);
    }, delay);
    return () => clearTimeout(timer);
  }, [accounts, refresh]);

  // A remote browser bills until released, so an abandoned sign-in must not
  // outlive this component. Best effort: on sign-out the auth session is gone
  // before unmount, and the server-side session expiry still releases it.
  useEffect(
    () => () => {
      const id = connectIdRef.current;
      if (id !== null) void cancelComputeConnect(id).catch(() => undefined);
    },
    [],
  );

  // Poll only while signing in; stops on any terminal state.
  useEffect(() => {
    if (phase !== 'signing_in') return;
    let cancelled = false;
    const timer = setInterval(() => {
      const id = connectIdRef.current;
      if (id === null) return;
      void pollComputeConnect(id)
        .then(async (result) => {
          if (cancelled) return;
          if (result.stage !== undefined) setStage(result.stage);
          // The browser is provisioned in the background, so the live view arrives
          // on a poll rather than from the initial POST.
          if (result.liveViewUrl != null) setLiveViewUrl(result.liveViewUrl);
          if (result.accountEmail != null) setConnectingAs(result.accountEmail);
          setPasskeyUnavailableFor(result.passkeyUnavailableFor ?? null);
          if (result.state === 'connected') {
            connectIdRef.current = null;
            setPhase('idle');
            setLiveViewUrl(null);
            await refresh();
          } else if (result.state === 'expired' || result.state === 'unknown') {
            connectIdRef.current = null;
            setPhase('error');
            setLiveViewUrl(null);
            setError(result.reason ?? 'Sign-in window closed. Try again.');
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, refresh]);

  const handleConnect = async () => {
    setError(null);
    setPhase('starting');
    setStage('creating_browser');
    setConnectingAs(null);
    setPasskeyUnavailableFor(null);
    setRunId((n) => n + 1);
    try {
      const handle = await startComputeConnect(provider);
      connectIdRef.current = handle.connectId;
      setLiveViewUrl(handle.liveViewUrl);
      setPhase('signing_in');
    } catch (err) {
      setPhase('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCancel = async () => {
    const id = connectIdRef.current;
    connectIdRef.current = null;
    setPhase('idle');
    setLiveViewUrl(null);
    setStage(null);
    if (id !== null) await cancelComputeConnect(id);
  };

  const handleRemove = async (account: ComputeAccount) => {
    setRemoving(account.accountId);
    try {
      await removeComputeAccount(account.provider, account.accountId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoving(null);
    }
  };

  return {
    accounts,
    phase,
    error,
    liveViewUrl,
    stage,
    connectingAs,
    passkeyUnavailableFor,
    runId,
    removing,
    /** Render clock, advanced on every tick and refetch. */
    now,
    connect: handleConnect,
    cancel: handleCancel,
    remove: handleRemove,
    isConnecting: phase === 'starting' || phase === 'signing_in',
  };
}
