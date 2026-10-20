/**
 * STATE MACHINE: usePhoneSession (the Phone app's live link to /api/phones)
 *
 *   enabled = Rose Desktop flag on && the Phone is open
 *
 *   [OFF] --enabled--> [LOADING] --GET /api/phones-->
 *        []          --> [NONE]   (connect message)
 *        error       --> [ERROR]
 *        [first, …]  --> [READY(phone)]
 *
 *   While [READY]                    every 2s   GET /:id            -> phone
 *   While [READY] && phone.online    every 500ms GET /:id/frame?after=<seq>
 *        (one request in flight, so ≤ 2 fps)  200 -> new blob URL, old one revoked
 *                                             204 -> keep the current frame
 *   While [READY] && holder = user   every 20s  POST take-control (renews the 60s lease)
 *
 *   takeControl() -> POST take-control -> phone      | 409 code -> actionError
 *   release()     -> POST release      -> phone      | error    -> actionError
 *   A state poll that overlaps a take-control/release is discarded, so a
 *   stale read never flips the UI back.
 *
 *   --disabled / unmount--> [OFF]: every interval cleared, in-flight requests
 *   aborted, the frame's blob URL revoked. A closed Phone makes no requests
 *   (10k-agent rule: polling cost exists only while a user is looking).
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

import {
  fetchPhoneFrame,
  getPhone,
  listPhones,
  PhoneApiError,
  releasePhoneControl,
  takePhoneControl,
  type PhoneState,
} from '@/lib/api/phones';

export const PHONE_STATE_POLL_MS = 2_000;
/** 500ms between frame pulls = at most 2 fps. */
export const PHONE_FRAME_INTERVAL_MS = 500;
/** The backend's user lease is 60s; renew well inside it. */
export const PHONE_LEASE_RENEW_MS = 20_000;

export const PHONE_CONNECT_MESSAGE = 'Connect your iPhone via iPhone Mirroring on your Mac';

const ERROR_TEXT: Record<string, string> = {
  PHONE_IN_USE_BY_USER: 'You are already controlling this iPhone in another window.',
  PHONE_IN_USE_BY_AGENT: 'Another agent is using this iPhone. Try again when it finishes.',
  PHONE_LEASE_LOST: 'Your control of this iPhone lapsed. Take control again.',
  PHONE_OFFLINE: PHONE_CONNECT_MESSAGE,
};

export function phoneErrorText(err: unknown): string {
  if (err instanceof PhoneApiError) {
    if (err.code !== null && err.code in ERROR_TEXT) return ERROR_TEXT[err.code];
    return err.message;
  }
  return 'Something went wrong. Try again.';
}

export type PhoneSessionStatus = 'loading' | 'none' | 'error' | 'ready';

export interface PhoneScreenFrame {
  url: string;
  width: number;
  height: number;
}

export interface PhoneSession {
  status: PhoneSessionStatus;
  phone: PhoneState | null;
  frame: PhoneScreenFrame | null;
  actionError: string | null;
  busy: boolean;
  takeControl: () => void;
  release: () => void;
}

type Setter<T> = (value: T) => void;

/** GET /api/phones once per open; picks the first phone. */
function usePhoneList(enabled: boolean, setPhone: Setter<PhoneState | null>) {
  const [status, setStatus] = useState<PhoneSessionStatus>('loading');
  useEffect(() => {
    if (!enabled) return undefined;
    const ctrl = new AbortController();
    setStatus('loading');
    listPhones(ctrl.signal)
      .then((phones) => {
        if (ctrl.signal.aborted) return;
        setPhone(phones[0] ?? null);
        setStatus(phones.length === 0 ? 'none' : 'ready');
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setStatus('error');
      });
    return () => {
      ctrl.abort();
      setPhone(null);
      setStatus('loading');
    };
  }, [enabled, setPhone]);
  return status;
}

/** Every 2s while open: GET /:id, unless a mutation overlapped the read. */
function useStatePoll(
  phoneId: string | null,
  epochRef: MutableRefObject<number>,
  setPhone: Setter<PhoneState | null>,
) {
  useEffect(() => {
    if (phoneId === null) return undefined;
    const ctrl = new AbortController();
    let inFlight = false;
    const poll = () => {
      if (inFlight) return;
      inFlight = true;
      const epoch = epochRef.current;
      getPhone(phoneId, ctrl.signal)
        .then((next) => {
          if (!ctrl.signal.aborted && epochRef.current === epoch) setPhone(next);
        })
        .catch(() => {
          // Keep the last known state; the next poll retries.
        })
        .finally(() => {
          inFlight = false;
        });
    };
    const id = setInterval(poll, PHONE_STATE_POLL_MS);
    return () => {
      clearInterval(id);
      ctrl.abort();
    };
  }, [phoneId, epochRef, setPhone]);
}

/** ≤ 2 fps frame pulls while the phone is online; owns (and revokes) blob URLs. */
function useFrameStream(phoneId: string | null, online: boolean) {
  const [frame, setFrame] = useState<PhoneScreenFrame | null>(null);
  useEffect(() => {
    if (phoneId === null || !online) return undefined;
    const ctrl = new AbortController();
    let inFlight = false;
    let lastSeq: number | null = null;
    let currentUrl: string | null = null;
    const pull = () => {
      if (inFlight) return;
      inFlight = true;
      fetchPhoneFrame(phoneId, lastSeq, ctrl.signal)
        .then((next) => {
          if (next === null || ctrl.signal.aborted) return;
          const previous = currentUrl;
          currentUrl = URL.createObjectURL(next.blob);
          lastSeq = next.seq;
          setFrame({ url: currentUrl, width: next.width, height: next.height });
          if (previous !== null) URL.revokeObjectURL(previous);
        })
        .catch(() => {
          // Transient read failure: the next pull retries.
        })
        .finally(() => {
          inFlight = false;
        });
    };
    pull();
    const id = setInterval(pull, PHONE_FRAME_INTERVAL_MS);
    return () => {
      clearInterval(id);
      ctrl.abort();
      if (currentUrl !== null) URL.revokeObjectURL(currentUrl);
      setFrame(null);
    };
  }, [phoneId, online]);
  return frame;
}

export function usePhoneSession(enabled: boolean): PhoneSession {
  const [phone, setPhone] = useState<PhoneState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const epochRef = useRef(0);
  const actionCtrlRef = useRef<AbortController | null>(null);

  const status = usePhoneList(enabled, setPhone);
  const phoneId = enabled && status === 'ready' && phone !== null ? phone.id : null;
  const online = phone?.online === true;
  const userHolds = phone?.holder.kind === 'user';

  useStatePoll(phoneId, epochRef, setPhone);
  const frame = useFrameStream(phoneId, online);

  // One abort scope per open Phone for take-control / release / renewals.
  useEffect(() => {
    if (phoneId === null) return undefined;
    const ctrl = new AbortController();
    actionCtrlRef.current = ctrl;
    return () => {
      ctrl.abort();
      actionCtrlRef.current = null;
      setActionError(null);
      setBusy(false);
    };
  }, [phoneId]);

  const mutate = useCallback(
    async (op: (id: string, signal: AbortSignal) => Promise<PhoneState>, quiet: boolean) => {
      const ctrl = actionCtrlRef.current;
      if (phoneId === null || ctrl === null) return;
      epochRef.current += 1;
      if (!quiet) {
        setBusy(true);
        setActionError(null);
      }
      try {
        const next = await op(phoneId, ctrl.signal);
        if (!ctrl.signal.aborted) setPhone(next);
      } catch (err) {
        if (!ctrl.signal.aborted) setActionError(phoneErrorText(err));
      } finally {
        epochRef.current += 1;
        if (!quiet && !ctrl.signal.aborted) setBusy(false);
      }
    },
    [phoneId],
  );

  // Renew the user's lease while they hold the phone.
  useEffect(() => {
    if (phoneId === null || !userHolds) return undefined;
    const id = setInterval(() => void mutate(takePhoneControl, true), PHONE_LEASE_RENEW_MS);
    return () => clearInterval(id);
  }, [phoneId, userHolds, mutate]);

  const takeControl = useCallback(() => void mutate(takePhoneControl, false), [mutate]);
  const release = useCallback(() => void mutate(releasePhoneControl, false), [mutate]);

  return { status, phone, frame, actionError, busy, takeControl, release };
}
