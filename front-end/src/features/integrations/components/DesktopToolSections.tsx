/**
 * STATE MACHINE: DesktopToolSections (Rose Desktop; data in useCliIntegrations / useMcpServers)
 *
 * Two ordinary integration sections, each ONE DesktopIntegrationRow so they look
 * like every other integration: the app-icon tile, account chips and the shared
 * sync bar.
 *
 *   CLIs        row "CLIs": one chip per CLI
 *     connected  → synced chip + its team-sharing caption (AccountTeamShare)
 *     setting_up → syncing chip + the shared sync bar; chip action "Open setup"
 *                  focuses the setup agent
 *     failed     → error chip, its reason under the chips; chip action "Retry"
 *                  reopens the form with the same request (disabled while a submit is pending)
 *   MCP servers row "MCP servers": one chip per server ("N tools")
 *     connected  → synced chip, × removes it
 *     needs_auth → warning chip; chip action "Sign in" (reconnect → OAuth)
 *     failed     → error chip + reason; chip action "Reconnect"
 *     desktop sign-in awaited (signingInId) → syncing chip + sync bar
 *
 *   no chips:  "Connect" ──► [FORM OPEN]   chips: "+ Add CLI" / "+ Add server" ──► [FORM OPEN]
 *   [FORM OPEN] --submit--> [SUBMITTING] --ok--> form closes, chip appears
 *                                        --refused--> error line, form stays filled
 *   [FORM OPEN] --Cancel--> [CLOSED]; inputs are disabled while [SUBMITTING]
 *   one MCP row action at a time: while one server is busy, others' actions are disabled
 *
 * Each section hides (stays mounted) when the integrations search does not match.
 */
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Loader2, Plug, Terminal } from 'lucide-react';

import { AccountTeamShare } from '@/components/teams/TeamSharing';
import { useAccountShares, type AccountShareLookup } from '@/hooks/useTeams';
import { openAgentInCurrentClient } from '@/lib/openAgent';
import { integrationMatchesSearch } from '../hooks/integrationSearch';
import { useCliIntegrations } from '../hooks/useCliIntegrations';
import { MCP_DEFAULT_HEADER_NAME, mcpHeaders, useMcpServers } from '../hooks/useMcpServers';
import DesktopIntegrationRow, {
  ACTION_CLASSES,
  DesktopSectionHeader,
  type DesktopAccountView,
  type DesktopIntegrationView,
} from './DesktopIntegrationRow';
import { DropdownIconPreset } from './DropdownIconFrame';

type Cli = ReturnType<typeof useCliIntegrations>;
type Mcp = ReturnType<typeof useMcpServers>;

const INPUT_CLASSES =
  'h-8 min-w-0 rounded-md border border-border bg-background px-2.5 text-[13px] outline-none placeholder:text-muted-foreground focus:border-foreground/40';
const CANCEL_CLASSES = 'shrink-0 text-[12.5px] text-muted-foreground hover:text-foreground';
const ERROR_CLASSES = 'text-xs text-destructive dark:text-red-300';

const glyph = (icon: ReactNode) => (
  <span className="flex h-full w-full items-center justify-center text-[#1f2937]">{icon}</span>
);

function ToolSection({
  title,
  hidden,
  children,
}: {
  title: string;
  hidden: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} hidden={hidden}>
      <DesktopSectionHeader>{title}</DesktopSectionHeader>
      {children}
    </section>
  );
}

/** The inline form under a row: indented to the chips, plain inputs, pink Connect. */
function RowForm({
  label,
  busy,
  error,
  onSubmit,
  onCancel,
  children,
}: {
  label: string;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <form aria-label={label} onSubmit={submit} className="ml-[46px] mt-2 flex flex-col gap-1.5">
      {/* Disabled while submitting, so a finishing submit never clears newer edits. */}
      <fieldset disabled={busy} className="flex flex-wrap items-center gap-2 disabled:opacity-70">
        {children}
        <button type="submit" className={ACTION_CLASSES} disabled={busy} aria-label={label}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Connect'}
        </button>
        <button type="button" className={CANCEL_CLASSES} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </fieldset>
      {error !== null && (
        <p role="alert" className={ERROR_CLASSES}>
          {error}
        </p>
      )}
    </form>
  );
}

/** Team-sharing caption for a connected CLI account the backend lists as shareable. */
function shareCaption(shareTarget: AccountShareLookup, id: string) {
  const target = shareTarget('cli', id);
  return target && <AccountTeamShare {...target} />;
}

function cliAccount(
  row: Cli['integrations'][number],
  retry: (request: string) => void,
  submitting: boolean,
  shareTarget: AccountShareLookup,
): DesktopAccountView {
  const base = { provider: 'cli', accountId: row.id, label: row.name };
  if (row.status === 'connected')
    return {
      ...base,
      tone: 'synced',
      title: 'Connected',
      share: shareCaption(shareTarget, row.id),
    };
  if (row.status === 'setting_up')
    return {
      ...base,
      tone: 'syncing',
      title: 'Setting up',
      ...(row.agent_id
        ? { onResync: () => openAgentInCurrentClient(row.agent_id!), resyncLabel: 'Open setup' }
        : {}),
    };
  return {
    ...base,
    tone: 'error',
    title: 'Setup failed',
    errorText: row.error || 'Setup failed',
    onResync: () => retry(row.request),
    resyncLabel: 'Retry',
    // Retry rewrites the draft: never while another submission is pending.
    disabled: submitting,
  };
}

function CliRow({ cli }: { cli: Cli }) {
  const { shareTarget } = useAccountShares();
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState('');
  const requestId = useRef<string | null>(null);
  const edit = (value: string) => {
    setRequest(value);
    requestId.current = null;
  };
  const retry = (previous: string) => {
    edit(previous);
    setOpen(true);
  };
  const submit = async () => {
    const value = request.trim();
    if (value === '') return;
    requestId.current ??= crypto.randomUUID();
    if (await cli.connect(value, requestId.current)) {
      setOpen(false);
      edit('');
    }
  };
  const view: DesktopIntegrationView = {
    key: 'clis',
    name: 'CLIs',
    icon: {
      preset: DropdownIconPreset.cli,
      glyph: glyph(<Terminal className="h-[70%] w-[70%]" />),
    },
    accounts: cli.integrations.map((row) => cliAccount(row, retry, cli.submitting, shareTarget)),
    availability: 'ready',
    onConnect: () => setOpen(true),
    connecting: cli.submitting,
    multiAccount: true,
    addLabel: 'Add CLI',
    extra: open ? (
      <RowForm
        label="Connect CLI"
        busy={cli.submitting}
        error={cli.error}
        onSubmit={() => void submit()}
        onCancel={() => setOpen(false)}
      >
        <input
          aria-label="CLI to connect"
          placeholder="e.g. YC (Y Combinator) CLI"
          value={request}
          maxLength={2000}
          autoFocus
          onChange={(event) => edit(event.target.value)}
          className={`${INPUT_CLASSES} flex-1`}
        />
      </RowForm>
    ) : cli.error !== null ? (
      <p role="alert" className={`ml-[46px] mt-2 ${ERROR_CLASSES}`}>
        {cli.error}
      </p>
    ) : undefined,
  };
  return <DesktopIntegrationRow view={view} />;
}

function mcpAccount(server: Mcp['servers'][number], mcp: Mcp): DesktopAccountView {
  const busy = mcp.busyId === server.id;
  // The hook runs one row action at a time: other servers' actions wait, visibly disabled.
  const otherBusy = mcp.busyId !== null && !busy;
  const tools = server.tools.length;
  const base = {
    provider: 'mcp',
    accountId: server.id,
    label: server.name,
    onRemove: () => void mcp.remove(server.id),
    removeLabel: `Remove ${server.name}`,
    removing: busy,
    disabled: otherBusy,
  };
  if (mcp.signingInId === server.id && server.status !== 'connected')
    return { ...base, tone: 'syncing', title: 'Signing in' };
  if (server.status === 'connected')
    return {
      ...base,
      tone: 'synced',
      detail: `${tools} tool${tools === 1 ? '' : 's'}`,
      title: 'Connected',
    };
  const reconnect = { onResync: () => void mcp.reconnect(server.id), resyncing: busy };
  if (server.status === 'needs_auth')
    return {
      ...base,
      ...reconnect,
      tone: 'warning',
      title: 'Sign in required',
      resyncLabel: 'Sign in',
    };
  return {
    ...base,
    ...reconnect,
    tone: 'error',
    title: 'Connection failed',
    errorText: server.error || 'Connection failed',
    resyncLabel: 'Reconnect',
  };
}

function McpRow({ mcp }: { mcp: Mcp }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [headerName, setHeaderName] = useState(MCP_DEFAULT_HEADER_NAME);
  const [headerValue, setHeaderValue] = useState('');
  const submit = async () => {
    const value = url.trim();
    if (value === '') return;
    const headers = mcpHeaders(headerName, headerValue);
    if (await mcp.connect({ url: value, ...(headers ? { headers } : {}) })) {
      setOpen(false);
      setUrl('');
      setHeaderValue('');
    }
  };
  const rowError = mcp.rowError ?? mcp.listError;
  const view: DesktopIntegrationView = {
    key: 'mcp',
    name: 'MCP servers',
    icon: { preset: DropdownIconPreset.mcp, glyph: glyph(<Plug className="h-[70%] w-[70%]" />) },
    accounts: mcp.servers.map((server) => mcpAccount(server, mcp)),
    availability: 'ready',
    onConnect: () => setOpen(true),
    connecting: mcp.connecting,
    multiAccount: true,
    addLabel: 'Add server',
    extra: (
      <>
        {open && (
          <RowForm
            label="Connect MCP server"
            busy={mcp.connecting}
            error={mcp.connectError}
            onSubmit={() => void submit()}
            onCancel={() => setOpen(false)}
          >
            <input
              aria-label="MCP server URL"
              placeholder="https://mcp.context7.com/mcp"
              value={url}
              autoFocus
              onChange={(event) => {
                setUrl(event.target.value);
                mcp.clearConnectError();
              }}
              className={`${INPUT_CLASSES} min-w-[9rem] flex-1`}
            />
            <input
              aria-label="Header name"
              value={headerName}
              onChange={(event) => setHeaderName(event.target.value)}
              className={`${INPUT_CLASSES} w-24`}
            />
            <input
              aria-label="Header value"
              placeholder="API key (optional)"
              type="password"
              value={headerValue}
              onChange={(event) => setHeaderValue(event.target.value)}
              className={`${INPUT_CLASSES} w-32`}
            />
          </RowForm>
        )}
        {rowError !== null && (
          <p role="alert" className={`ml-[46px] mt-2 ${ERROR_CLASSES}`}>
            {rowError}
          </p>
        )}
      </>
    ),
  };
  return <DesktopIntegrationRow view={view} />;
}

export default function DesktopToolSections({ search }: { search: string }) {
  const cli = useCliIntegrations();
  const mcp = useMcpServers();
  return (
    <>
      <ToolSection title="CLIs" hidden={!integrationMatchesSearch('clis', search)}>
        <CliRow cli={cli} />
      </ToolSection>
      <ToolSection title="MCP servers" hidden={!integrationMatchesSearch('mcp', search)}>
        <McpRow mcp={mcp} />
      </ToolSection>
    </>
  );
}
