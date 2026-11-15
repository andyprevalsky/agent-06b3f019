/**
 * STATE MACHINE: useMcpServers (McpServersSection)
 *
 *   [MOUNT] --GET /integrations/mcp--> [LISTED] (merged: rows a faster mutation set win,
 *     rows removed meanwhile stay removed) | listError
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
 * Each poll run has an identity (a newer sign-in replaces it), and responses
 * from an older request or from before a mutation never overwrite newer state.
 * A browser that fails to open ({success:false} or a rejection) is a connect error.
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
  /** Identity of the current desktop sign-in poll; a replaced or stopped run ignores its callbacks. */
  const pollRun = useRef(0);
  /** Bumped by every successful mutation; poll responses started earlier are dropped. */
  const mutation = useRef(0);
  /** Rows removed here; a list response that was already in flight never restores them. */
  const removed = useRef(new Set<string>());

  useEffect(() => {
    mounted.current = true;
    fetchMcpServers()
      .then((rows) => {
        // Merge: rows a faster connect/reconnect set win; removed rows stay removed.
        if (mounted.current)
          setServers((current) => {
            const byId = new Map(
              rows.filter((row) => !removed.current.has(row.id)).map((row) => [row.id, row]),
            );
            for (const row of current) byId.set(row.id, row);
            return [...byId.values()];
          });
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
      pollRun.current += 1;
      if (poll.current !== null) clearInterval(poll.current);
    },
    [],
  );

  /** Desktop: wait for the system-browser sign-in to land server-side. */
  const awaitDesktopSignIn = useCallback((id: string) => {
    if (poll.current !== null) clearInterval(poll.current);
    const run = ++pollRun.current;
    const startedAt = Date.now();
    let applied = 0;
    let sent = 0;
    const handle = setInterval(() => {
      const stop = () => {
        // Invalidate this run too, so its in-flight responses cannot apply afterwards.
        if (run === pollRun.current) pollRun.current += 1;
        clearInterval(handle);
        if (poll.current === handle) poll.current = null;
      };
      if (run !== pollRun.current || !mounted.current) return stop();
      if (Date.now() - startedAt > MCP_SIGN_IN_TIMEOUT_MS) return stop();
      const request = ++sent;
      const startedMutation = mutation.current;
      void fetchMcpServers()
        .then((rows) => {
          // Drop responses from a replaced run, an older request, or before a mutation.
          if (run !== pollRun.current || !mounted.current) return;
          if (request < applied || startedMutation !== mutation.current) return;
          applied = request;
          setServers(rows);
          if (rows.some((row) => row.id === id && row.status === 'connected')) stop();
        })
        .catch(() => undefined);
    }, MCP_SIGN_IN_POLL_MS);
    poll.current = handle;
  }, []);

  /** Upserts the row; for authorize_url, starts sign-in (throws if the browser cannot open). */
  const apply = useCallback(
    async (result: McpServerResult): Promise<void> => {
      mutation.current += 1;
      setServers((rows) => [...rows.filter((row) => row.id !== result.server.id), result.server]);
      if (!result.authorize_url) return;
      const openExternal = window.api?.openExternal;
      if (!openExternal) return startSignIn(result.authorize_url);
      const opened = await openExternal(result.authorize_url);
      if (
        typeof opened === 'object' &&
        opened !== null &&
        'success' in opened &&
        opened.success === false
      )
        throw new Error('Could not open your browser to sign in. Try again.');
      awaitDesktopSignIn(result.server.id);
    },
    [awaitDesktopSignIn],
  );

  const connect = async (input: McpConnectInput): Promise<boolean> => {
    if (connecting) return false;
    setConnecting(true);
    setConnectError(null);
    try {
      const result = await connectMcpServer(input, mcpRedirectUri());
      if (mounted.current) await apply(result);
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
        if (mounted.current) await apply(result);
      },
      'Could not reconnect MCP server',
    );

  const remove = (id: string) =>
    runRowAction(
      id,
      async () => {
        await deleteMcpServer(id);
        mutation.current += 1;
        removed.current.add(id);
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
