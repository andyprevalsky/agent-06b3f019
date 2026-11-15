/**
 * STATE MACHINE: CliIntegrationsSection (state in useCliIntegrations)
 *
 * CLOSED --Add CLI--> PROMPT --submit--> SETTING_UP --server verifies--> CONNECTED
 *                              |                     --server fails--> FAILED --Retry--> PROMPT
 *                              --request error--> PROMPT (same idempotency key)
 * Integrations page -> CLI API -> user's template setup agent -> verified CLI list.
 * A successful start automatically opens the normal Rose setup agent.
 *
 * Card look matches GitHub Repos and MCP servers (integrationCardStyles): app-icon
 * tile, title and detail line, plain inputs and the dark Connect button. Rendered
 * the same way on the stock page and in Rose Desktop.
 */
import { useRef, useState } from 'react';
import { Loader2, Plus, Terminal, X } from 'lucide-react';
import claudeIcon from '@/assets/claude-color.svg';
import { openAgentInCurrentClient } from '@/lib/openAgent';
import { useCliIntegrations } from '../hooks/useCliIntegrations';
import {
  INTEGRATION_ADD_BUTTON_CLASSES,
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

type CliIntegration = ReturnType<typeof useCliIntegrations>['integrations'][number];

export function CliIntegrationsIcon() {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-lg bg-[#1f2328] text-white">
      <Terminal className="h-5 w-5" aria-hidden="true" />
    </div>
  );
}

function detailText(cli: ReturnType<typeof useCliIntegrations>): string {
  const count = cli.integrations.filter((row) => row.status === 'connected').length;
  if (count === 0) return 'Connect command-line tools for your agents';
  return `${count} CLI${count === 1 ? '' : 's'} connected`;
}

function CliStatus({ integration, onRetry }: { integration: CliIntegration; onRetry: () => void }) {
  if (integration.status === 'setting_up')
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Setting up…</span>
      </span>
    );
  if (integration.status === 'connected')
    return <span className="text-xs text-green-600 dark:text-green-400">Connected</span>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate text-xs text-destructive">
        {integration.error || 'Setup failed'}
      </span>
      <button type="button" className={INTEGRATION_TEXT_ACTION_CLASSES} onClick={onRetry}>
        Retry
      </button>
    </span>
  );
}

export default function CliIntegrationsSection() {
  const cli = useCliIntegrations();
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState('');
  const requestId = useRef<string | null>(null);

  const editRequest = (value: string) => {
    setRequest(value);
    requestId.current = null;
  };
  const submit = async () => {
    if (!request.trim()) return;
    requestId.current ??= crypto.randomUUID();
    if (await cli.connect(request.trim(), requestId.current)) {
      setOpen(false);
      editRequest('');
    }
  };

  return (
    <section aria-label="CLIs" className={INTEGRATION_CARD_CLASSES}>
      <div className={`${INTEGRATION_CARD_HEADER_CLASSES} justify-between`}>
        <div className="flex min-w-0 items-center gap-3">
          <div className={INTEGRATION_ICON_TILE_CLASSES}>
            <CliIntegrationsIcon />
          </div>
          <div className="flex min-w-0 flex-col">
            <h3 className="font-medium">CLIs</h3>
            <span className="text-xs text-muted-foreground">{detailText(cli)}</span>
          </div>
        </div>
        <button
          type="button"
          aria-label="Add CLI"
          onClick={() => setOpen(true)}
          className={INTEGRATION_ADD_BUTTON_CLASSES}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      {cli.integrations.length > 0 && (
        <ul aria-label="Connected CLIs" aria-live="polite" className="border-t border-border">
          {cli.integrations.map((integration) => (
            <li key={integration.id} className={INTEGRATION_ROW_CLASSES}>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-medium">{integration.name}</span>
                <CliStatus
                  integration={integration}
                  onRetry={() => {
                    editRequest(integration.request);
                    setOpen(true);
                  }}
                />
              </div>
              {integration.agent_id && (
                <button
                  type="button"
                  className={INTEGRATION_TEXT_ACTION_CLASSES}
                  onClick={() => openAgentInCurrentClient(integration.agent_id!)}
                >
                  Open setup
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {cli.error && (
        <div className="flex items-center gap-2 px-4 pb-3">
          <p role="alert" className="text-xs text-destructive">
            {cli.error}
          </p>
          <button
            type="button"
            className={INTEGRATION_TEXT_ACTION_CLASSES}
            disabled={cli.loading}
            onClick={() => void cli.refresh()}
          >
            Refresh CLIs
          </button>
        </div>
      )}
      {open && (
        <form
          className={INTEGRATION_FORM_CLASSES}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex items-center gap-2">
            <img src={claudeIcon} alt="Claude" className="h-5 w-5" />
            <label htmlFor="cli-setup-request" className="text-sm">
              Enter the CLI you want to connect
            </label>
            <button
              type="button"
              aria-label="Cancel CLI setup"
              disabled={cli.submitting}
              onClick={() => setOpen(false)}
              className={`${INTEGRATION_ICON_BUTTON_CLASSES} ml-auto h-6 w-6`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="cli-setup-request"
              placeholder="e.g. YC (Y Combinator) CLI"
              value={request}
              onChange={(event) => editRequest(event.target.value)}
              disabled={cli.submitting}
              maxLength={2000}
              autoFocus
              className={`${INTEGRATION_INPUT_CLASSES} flex-1`}
            />
            <button
              type="submit"
              disabled={cli.submitting || !request.trim()}
              className={INTEGRATION_CONNECT_BUTTON_CLASSES}
            >
              {cli.submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {cli.submitting ? 'Starting…' : 'Connect'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
