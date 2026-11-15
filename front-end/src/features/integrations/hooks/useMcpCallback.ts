/**
 * STATE MACHINE: useMcpCallback (McpCallback page)
 *
 *   [COMPLETING] --?error / missing code or state--> [ERROR]
 *   [COMPLETING] --POST /integrations/mcp/oauth/complete ok--> [DONE] --> back to
 *                                                   the page that started sign-in
 *   [COMPLETING] --refused / not signed in--> [ERROR]
 */

import { useEffect, useRef, useState } from 'react';

import { completeMcpServerOAuth } from '../api/mcp';
import { MCP_RETURN_KEY } from '../config';

export type McpCallbackState = 'completing' | 'done' | 'error';

export function useMcpCallback(): { state: McpCallbackState; message: string | null } {
  const [state, setState] = useState<McpCallbackState>('completing');
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
        error === null
          ? 'The MCP server did not return a sign-in code.'
          : `MCP server sign-in ${error}.`,
      );
      return;
    }
    completeMcpServerOAuth(code, oauthState)
      .then(() => {
        setState('done');
        const back = sessionStorage.getItem(MCP_RETURN_KEY) ?? '/';
        sessionStorage.removeItem(MCP_RETURN_KEY);
        window.location.replace(back);
      })
      .catch((err: unknown) => {
        setState('error');
        const text = err instanceof Error ? err.message : String(err);
        setMessage(
          text === 'Not authenticated'
            ? 'Sign in to Rose in this browser, then connect the MCP server again.'
            : text,
        );
      });
  }, []);

  return { state, message };
}
