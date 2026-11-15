/**
 * STATE MACHINE: McpServersSection (state in useMcpServers)
 *
 *   [LOADING] --> [LISTED] each server: name · URL host · status
 *     (connected + tool count | "Sign in required" | the error) and actions
 *   [LISTED] --server URL (+ optional "API key header" name/value) · Connect-->
 *     [CONNECTING] --ok--> [LISTED] (form cleared)
 *                  --authorize_url--> browser goes to the server's OAuth sign-in;
 *                    /integrations/mcp/callback (McpCallback) finishes and returns
 *                  --refused--> [LISTED] + inline error
 *   [LISTED] --Sign in (needs_auth) / Reconnect (failed)--> [RECONNECTING]
 *     --ok--> row updated | --authorize_url--> OAuth sign-in | inline error
 *   [LISTED] --× on a row--> [REMOVING] --204--> row gone | inline error
 *
 * "API key header" disclosure: CLOSED --toggle--> OPEN (name defaults to
 * Authorization). Headers are sent only when a value is filled; with the
 * Authorization name the value is sent as "Bearer <value>" unless it already
 * starts with "Bearer ".
 *
 * Card look matches GitHub Repos and CLIs (integrationCardStyles).
 */

import { useState, type FormEvent } from 'react';
import { ChevronDown, ChevronRight, Loader2, Plug, Plus, X } from 'lucide-react';

import { MCP_DEFAULT_HEADER_NAME, mcpHeaders, useMcpServers } from '../hooks/useMcpServers';
import {
  INTEGRATION_CARD_CLASSES,
  INTEGRATION_CARD_HEADER_CLASSES,
  INTEGRATION_CONNECT_BUTTON_CLASSES,
  INTEGRATION_FORM_CLASSES,
  INTEGRATION_ICON_BUTTON_CLASSES,
  INTEGRATION_ICON_TILE_CLASSES,
  INTEGRATION_INPUT_CLASSES,
  INTEGRATION_ROW_CLASSES,
  INTEGRATION_TEXT_ACTION_CLASSES,
} from './integrationCardStyles';

type McpState = ReturnType<typeof useMcpServers>;
type McpServer = McpState['servers'][number];

export function McpServersIcon() {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-lg bg-[#2b2d42] text-white">
      <Plug className="h-5 w-5" aria-hidden="true" />
    </div>
  );
}

function detailText(mcp: McpState): string {
  if (mcp.loading) return 'Loading...';
  const count = mcp.servers.filter((server) => server.status === 'connected').length;
  if (count === 0) return 'Connect MCP servers to give your agents their tools';
  return `${count} server${count === 1 ? '' : 's'} connected`;
}

function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function ServerStatus({ server }: { server: McpServer }) {
  if (server.status === 'connected') {
    const count = server.tools.length;
    return (
      <span className="text-xs text-green-600 dark:text-green-400">
        Connected · {count} tool{count === 1 ? '' : 's'}
      </span>
    );
  }
  if (server.status === 'needs_auth')
    return <span className="text-xs text-amber-600 dark:text-amber-400">Sign in required</span>;
  return (
    <span className="truncate text-xs text-destructive">{server.error || 'Connection failed'}</span>
  );
}

function ServerRow({ server, mcp }: { server: McpServer; mcp: McpState }) {
  const busy = mcp.busyId === server.id;
  const action = server.status === 'needs_auth' ? 'Sign in' : 'Reconnect';
  return (
    <li className={INTEGRATION_ROW_CLASSES}>
      <div className="flex min-w-0 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{server.name}</span>
          <span className="truncate text-xs text-muted-foreground">{urlHost(server.url)}</span>
        </div>
        <ServerStatus server={server} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {server.status !== 'connected' && (
          <button
            type="button"
            aria-label={`${action} ${server.name}`}
            onClick={() => void mcp.reconnect(server.id)}
            disabled={mcp.busyId !== null}
            className={INTEGRATION_TEXT_ACTION_CLASSES}
          >
            {action}
          </button>
        )}
        <button
          type="button"
          aria-label={`Remove ${server.name}`}
          title={`Remove ${server.name}`}
          onClick={() => void mcp.remove(server.id)}
          disabled={mcp.busyId !== null}
          className={INTEGRATION_ICON_BUTTON_CLASSES}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
        </button>
      </div>
    </li>
  );
}

function ConnectForm({ mcp }: { mcp: McpState }) {
  const [url, setUrl] = useState('');
  const [headerOpen, setHeaderOpen] = useState(false);
  const [headerName, setHeaderName] = useState(MCP_DEFAULT_HEADER_NAME);
  const [headerValue, setHeaderValue] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const serverUrl = url.trim();
    if (serverUrl === '') return;
    const headers = mcpHeaders(headerName, headerValue);
    if (await mcp.connect({ url: serverUrl, ...(headers ? { headers } : {}) })) {
      setUrl('');
      setHeaderValue('');
    }
  };
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    mcp.clearConnectError();
  };
  return (
    <form onSubmit={(e) => void submit(e)} className={INTEGRATION_FORM_CLASSES}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="MCP server URL"
          placeholder="https://mcp.context7.com/mcp"
          value={url}
          onChange={(e) => edit(setUrl)(e.target.value)}
          aria-invalid={mcp.connectError !== null}
          className={`${INTEGRATION_INPUT_CLASSES} flex-1`}
        />
        <button
          type="submit"
          aria-label="Connect MCP server"
          disabled={mcp.connecting || url.trim() === ''}
          className={INTEGRATION_CONNECT_BUTTON_CLASSES}
        >
          {mcp.connecting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Connect
        </button>
      </div>
      <button
        type="button"
        aria-expanded={headerOpen}
        onClick={() => setHeaderOpen((value) => !value)}
        className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {headerOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        API key header (optional)
      </button>
      {headerOpen && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Header name"
            value={headerName}
            onChange={(e) => edit(setHeaderName)(e.target.value)}
            className={`${INTEGRATION_INPUT_CLASSES} max-w-[12rem]`}
          />
          <input
            aria-label="Header value"
            type="password"
            autoComplete="off"
            placeholder="API key"
            value={headerValue}
            onChange={(e) => edit(setHeaderValue)(e.target.value)}
            className={`${INTEGRATION_INPUT_CLASSES} flex-1`}
          />
        </div>
      )}
      {mcp.connectError !== null && (
        <p role="alert" className="text-xs text-destructive">
          {mcp.connectError}
        </p>
      )}
    </form>
  );
}

export default function McpServersSection() {
  const mcp = useMcpServers();
  return (
    <section aria-label="MCP servers" className={INTEGRATION_CARD_CLASSES}>
      <div className={INTEGRATION_CARD_HEADER_CLASSES}>
        <div className={INTEGRATION_ICON_TILE_CLASSES}>
          <McpServersIcon />
        </div>
        <div className="flex min-w-0 flex-col">
          <h3 className="font-medium">MCP servers</h3>
          <span className="text-xs text-muted-foreground">{detailText(mcp)}</span>
          {mcp.listError !== null && (
            <span role="alert" className="text-xs text-destructive">
              Could not load MCP servers: {mcp.listError}
            </span>
          )}
        </div>
      </div>
      {mcp.servers.length > 0 && (
        <ul aria-label="Connected MCP servers" className="border-t border-border">
          {mcp.servers.map((server) => (
            <ServerRow key={server.id} server={server} mcp={mcp} />
          ))}
        </ul>
      )}
      {mcp.rowError !== null && (
        <p role="alert" className="px-4 pb-2 text-xs text-destructive">
          {mcp.rowError}
        </p>
      )}
      <ConnectForm mcp={mcp} />
    </section>
  );
}
