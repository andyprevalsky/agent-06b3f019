/**
 * STATE MACHINE: useMcpServers (McpServersSection)
 *
 *   [MOUNT] --GET /integrations/mcp--> [LISTED] (merged with rows a faster connect added) | listError
 *   [LISTED] --connect(url, headers?)--> [CONNECTING]
 *     --{server}--> [LISTED] (row upserted)
 *     --{server, authorize_url}--> remember this page (MCP_RETURN_KEY) and send
 *       the browser to the server's OAuth sign-in (MCP callback page finishes it)
 *     --refused--> [LISTED] + connectError
 *   [LISTED] --reconnect(id) (needs_auth | failed row)--> [RECONNECTING id]
 *     --{server}--> row replaced | --authorize_url--> browser to sign-in | rowError
 *   [LISTED] --remove(id)--> [REMOVING id] --204--> row dropped | rowError
 *
 * Rose Desktop (window.api.openExternal): sign-in opens the system browser and
 * returns to the public web origin's callback; this hook then re-lists every
 * MCP_SIGN_IN_POLL_MS until that row is connected (or MCP_SIGN_IN_TIMEOUT_MS).
 *
 * The backend owns connection state; the client never guesses it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  connectMcpServer,
  deleteMcpServer,
  fetchMcpServers,
  reconnectMcpServer,
  type McpConnectInput,
  type McpServer,
  type McpServerResult,
} from '../api/mcp';
import { MCP_CALLBACK_PATH, MCP_RETURN_KEY, MEETING_NOTES_PUBLIC_ORIGIN } from '../config';

const message = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

export const MCP_DEFAULT_HEADER_NAME = 'Authorization';

/** Headers to send, or undefined when no value is filled. */
export function mcpHeaders(name: string, value: string): Record<string, string> | undefined {
  const headerValue = value.trim();
  if (headerValue === '') return undefined;
  const headerName = name.trim() || MCP_DEFAULT_HEADER_NAME;
  const bearer =
    headerName.toLowerCase() === MCP_DEFAULT_HEADER_NAME.toLowerCase() &&
    !headerValue.startsWith('Bearer ');
  return { [headerName]: bearer ? `Bearer ${headerValue}` : headerValue };
}

export const MCP_SIGN_IN_POLL_MS = 3_000;
export const MCP_SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/** The desktop app signs in through the system browser and the public web callback. */
export const mcpRedirectUri = () =>
  `${window.api?.openExternal ? MEETING_NOTES_PUBLIC_ORIGIN : window.location.origin}${MCP_CALLBACK_PATH}`;

/** Remember this page, then send the browser to the server's OAuth sign-in. */
function startSignIn(authorizeUrl: string): void {
  sessionStorage.setItem(MCP_RETURN_KEY, window.location.pathname + window.location.search);
  window.location.href = authorizeUrl;
}

export function useMcpServers() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    fetchMcpServers()
      .then((rows) => {
        // Merge: a connect that finished before this first load keeps its row.
        if (mounted.current)
          setServers((current) => [
            ...rows,
            ...current.filter((row) => !rows.some((loaded) => loaded.id === row.id)),
          ]);
      })
      .catch((cause: unknown) => {
        if (mounted.current) setListError(message(cause, 'Could not load MCP servers'));
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, []);

  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(
    () => () => {
      if (poll.current !== null) clearInterval(poll.current);
    },
    [],
  );

  /** Desktop: wait for the system-browser sign-in to land server-side. */
  const awaitDesktopSignIn = useCallback((id: string) => {
    if (poll.current !== null) clearInterval(poll.current);
    const startedAt = Date.now();
    poll.current = setInterval(() => {
      if (!mounted.current || Date.now() - startedAt > MCP_SIGN_IN_TIMEOUT_MS) {
        if (poll.current !== null) clearInterval(poll.current);
        poll.current = null;
        return;
      }
      void fetchMcpServers()
        .then((rows) => {
          if (!mounted.current) return;
          setServers(rows);
          if (rows.some((row) => row.id === id && row.status === 'connected')) {
            if (poll.current !== null) clearInterval(poll.current);
            poll.current = null;
          }
        })
        .catch(() => undefined);
    }, MCP_SIGN_IN_POLL_MS);
  }, []);

  const apply = useCallback(
    (result: McpServerResult) => {
      setServers((rows) => [...rows.filter((row) => row.id !== result.server.id), result.server]);
      if (!result.authorize_url) return;
      const openExternal = window.api?.openExternal;
      if (!openExternal) return startSignIn(result.authorize_url);
      void Promise.resolve(openExternal(result.authorize_url)).then(() =>
        awaitDesktopSignIn(result.server.id),
      );
    },
    [awaitDesktopSignIn],
  );

  const connect = async (input: McpConnectInput): Promise<boolean> => {
    if (connecting) return false;
    setConnecting(true);
    setConnectError(null);
    try {
      const result = await connectMcpServer(input, mcpRedirectUri());
      if (mounted.current) apply(result);
      return true;
    } catch (cause) {
      if (mounted.current) setConnectError(message(cause, 'Could not connect MCP server'));
      return false;
    } finally {
      if (mounted.current) setConnecting(false);
    }
  };

  const runRowAction = async (id: string, action: () => Promise<void>, fallback: string) => {
    if (busyId !== null) return;
    setBusyId(id);
    setRowError(null);
    try {
      await action();
    } catch (cause) {
      if (mounted.current) setRowError(message(cause, fallback));
    } finally {
      if (mounted.current) setBusyId(null);
    }
  };

  const reconnect = (id: string) =>
    runRowAction(
      id,
      async () => {
        const result = await reconnectMcpServer(id, mcpRedirectUri());
        if (mounted.current) apply(result);
      },
      'Could not reconnect MCP server',
    );

  const remove = (id: string) =>
    runRowAction(
      id,
      async () => {
        await deleteMcpServer(id);
        if (mounted.current) setServers((rows) => rows.filter((row) => row.id !== id));
      },
      'Could not remove MCP server',
    );

  return {
    servers,
    loading,
    listError,
    connecting,
    connectError,
    clearConnectError: () => setConnectError(null),
    busyId,
    rowError,
    connect,
    reconnect,
    remove,
  };
}
