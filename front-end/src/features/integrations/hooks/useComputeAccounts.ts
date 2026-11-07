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

  const refresh = useCallback(async () => {
    try {
      setAccounts(await fetchComputeAccounts(provider));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [provider]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
    connect: handleConnect,
    cancel: handleCancel,
    remove: handleRemove,
    isConnecting: phase === 'starting' || phase === 'signing_in',
  };
}
