/**
 * STATE MACHINE: useMeetingNotesCallback (GranolaCallback page)
 *
 *   [COMPLETING] --?error / missing code or state--> [ERROR]
 *   [COMPLETING] --POST /oauth/complete ok--> [DONE] --> back to the page that
 *                                                       started sign-in
 *   [COMPLETING] --refused / not signed in--> [ERROR]
 */

import { useEffect, useRef, useState } from 'react';

import { completeMeetingNotesSignInApi } from '../api/meetingNotes';
import {
  meetingNotesProviders,
  meetingNotesReturnKey,
  type MeetingNotesProvider,
} from '../meetingNotes';

export type MeetingNotesCallbackState = 'completing' | 'done' | 'error';

export function useMeetingNotesCallback(provider: MeetingNotesProvider): {
  state: MeetingNotesCallbackState;
  message: string | null;
} {
  const { name } = meetingNotesProviders[provider];
  const [state, setState] = useState<MeetingNotesCallbackState>('completing');
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
        error === null ? `${name} did not return a sign-in code.` : `${name} sign-in ${error}.`,
      );
      return;
    }
    completeMeetingNotesSignInApi(provider, code, oauthState)
      .then(() => {
        setState('done');
        const back = sessionStorage.getItem(meetingNotesReturnKey(provider)) ?? '/';
        sessionStorage.removeItem(meetingNotesReturnKey(provider));
        window.location.replace(back);
      })
      .catch((err: unknown) => {
        setState('error');
        const text = err instanceof Error ? err.message : String(err);
        setMessage(
          text === 'Not authenticated'
            ? `Sign in to Rose in this browser, then connect ${name} again.`
            : text,
        );
      });
  }, [provider, name]);

  return { state, message };
}
