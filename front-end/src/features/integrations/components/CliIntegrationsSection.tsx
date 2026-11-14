/**
 * CLOSED --Add CLI--> PROMPT --submit--> SETTING_UP --server verifies--> CONNECTED
 *                              |                     --server fails--> FAILED --Retry--> PROMPT
 *                              --request error--> PROMPT (same idempotency key)
 * Integrations page -> CLI API -> user's template setup agent -> verified CLI list.
 * A successful start automatically opens the normal Rose setup agent.
 */
import { useRef, useState } from 'react';
import { Loader2, Plus, Terminal, X } from 'lucide-react';
import claudeIcon from '@/assets/claude-color.svg';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { openAgentInCurrentClient } from '@/lib/openAgent';
import { useCliIntegrations } from '../hooks/useCliIntegrations';

export default function CliIntegrationsSection({ desktop = false }: { desktop?: boolean }) {
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
    <section
      aria-label="CLIs"
      className={desktop ? 'py-2' : 'rounded-lg border border-border bg-card/60 overflow-hidden'}
    >
      <div className="flex items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-3">
          <Terminal className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <div>
            <h3 className="font-medium">CLIs</h3>
            <p className="text-xs text-muted-foreground">Connect tools for your agents</p>
          </div>
        </div>
        <Button size="icon" variant="ghost" aria-label="Add CLI" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {open && (
        <form
          className="mx-4 mb-4 rounded-lg border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="mb-3 flex items-center gap-2">
            <img src={claudeIcon} alt="Claude" className="h-5 w-5" />
            <label htmlFor="cli-setup-request" className="text-sm">
              Enter the CLI you want to connect
            </label>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="ml-auto h-6 w-6"
              aria-label="Cancel CLI setup"
              disabled={cli.submitting}
              onClick={() => setOpen(false)}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
          <div className="flex gap-2">
            <Input
              id="cli-setup-request"
              placeholder="e.g. YC CLI"
              value={request}
              onChange={(event) => editRequest(event.target.value)}
              disabled={cli.submitting}
              maxLength={2000}
              autoFocus
            />
            <Button type="submit" disabled={cli.submitting || !request.trim()}>
              {cli.submitting ? 'Starting…' : 'Connect'}
            </Button>
          </div>
        </form>
      )}
      {cli.error && (
        <div className="px-4 pb-3">
          <p role="alert" className="text-sm text-destructive">
            {cli.error}
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={cli.loading}
            onClick={() => void cli.refresh()}
          >
            Refresh CLIs
          </Button>
        </div>
      )}
      <div aria-live="polite">
        {cli.integrations.map((integration) => (
          <div
            key={integration.id}
            className="flex flex-wrap items-center gap-2 border-t border-border/50 px-4 py-3"
          >
            <span className="text-sm font-medium">{integration.name}</span>
            {integration.status === 'setting_up' && (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                <span className="text-xs text-muted-foreground">Setting up…</span>
              </>
            )}
            {integration.status === 'connected' && (
              <span className="text-xs text-green-600">Connected</span>
            )}
            {integration.status === 'failed' && (
              <>
                <span className="text-xs text-destructive">
                  {integration.error || 'Setup failed'}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    editRequest(integration.request);
                    setOpen(true);
                  }}
                >
                  Retry
                </Button>
              </>
            )}
            {integration.agent_id && (
              <Button
                className="ml-auto"
                size="sm"
                variant="ghost"
                onClick={() => openAgentInCurrentClient(integration.agent_id!)}
              >
                Open setup
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
