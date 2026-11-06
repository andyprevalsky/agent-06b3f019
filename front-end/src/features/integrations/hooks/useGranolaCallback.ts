/**
 * STATE MACHINE: useGranolaCallback (GranolaCallback page)
 *
 *   [COMPLETING] --?error / missing code or state--> [ERROR]
 *   [COMPLETING] --POST /oauth/complete ok--> [DONE] --> back to the page that
 *                                                       started sign-in
 *   [COMPLETING] --refused / not signed in--> [ERROR]
 */

import { useEffect, useRef, useState } from 'react';

import { completeGranolaSignInApi } from '../api/granola';
import { GRANOLA_RETURN_KEY } from '../config';

export type GranolaCallbackState = 'completing' | 'done' | 'error';

export function useGranolaCallback(): { state: GranolaCallbackState; message: string | null } {
  const [state, setState] = useState<GranolaCallbackState>('completing');
  const [message, setMessage] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const oauthState = params.get('state');
    const error = params.get('error');
    if (error !== null || code === null || oauthState === null) {
      setState('error');
      setMessage(
        error === null ? 'Granola did not return a sign-in code.' : `Granola sign-in ${error}.`,
      );
      return;
    }
    completeGranolaSignInApi(code, oauthState)
      .then(() => {
        setState('done');
        const back = sessionStorage.getItem(GRANOLA_RETURN_KEY) ?? '/';
        sessionStorage.removeItem(GRANOLA_RETURN_KEY);
        window.location.replace(back);
      })
      .catch((err: unknown) => {
        setState('error');
        const text = err instanceof Error ? err.message : String(err);
        setMessage(
          text === 'Not authenticated'
            ? 'Sign in to Rose in this browser, then connect Granola again.'
            : text,
        );
      });
  }, []);

  return { state, message };
}
