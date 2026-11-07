import { Loader2 } from 'lucide-react';
import { useIPhoneConnection } from '../hooks/useIPhoneConnection';

function AppleIcon() {
  return (
    <svg
      data-testid="iphone-apple-icon"
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-6 w-6 fill-current"
    >
      <path d="M16.2 3.2c.7-.9 1.1-2 1-3.2-1 .1-2.3.7-3 1.6-.7.8-1.2 2-1 3.1 1.1.1 2.3-.6 3-1.5Zm3.6 9.5c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-2-1-3.3-.9-1.7 0-3.2 1-4.1 2.4-1.8 3-.5 7.6 1.2 10 .8 1.2 1.8 2.5 3.1 2.5 1.3-.1 1.7-.8 3.3-.8 1.5 0 1.9.8 3.3.8 1.4 0 2.2-1.2 3-2.4 1-1.4 1.4-2.7 1.4-2.8-.1 0-2.8-1.1-2.8-4.1Z" />
    </svg>
  );
}

export default function IPhoneConnectionSection() {
  const { status, busy, error, connect } = useIPhoneConnection();
  const unavailable = status !== null && (!status.enabled || !status.configured);
  const ready = status?.status === 'ready';
  const settingUp = status?.status === 'setting_up';
  const reauth = status?.status === 'needs_reauth';
  const label =
    status === null
      ? 'Checking iPhone connection…'
      : ready
        ? 'Connected'
        : settingUp
          ? 'Setting up'
          : reauth
            ? 'Needs reauth'
            : 'Connect your iPhone to Rose';
  return (
    <section
      aria-label="iPhone connection"
      className="rounded-lg border border-border bg-card/60 p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <AppleIcon />
          </div>
          <div className="min-w-0">
            <h3 className="font-medium">iPhone</h3>
            <p className="text-xs text-muted-foreground" role="status">
              {label}
            </p>
            {unavailable && (
              <p className="text-xs text-muted-foreground">
                To enable iPhone access, email{' '}
                <a className="underline" href="mailto:andy@roselabs.ai">
                  andy@roselabs.ai
                </a>
                .
              </p>
            )}
            {status?.setupAgentId && (
              <a
                className="text-xs underline"
                href={`/?agent-id=${encodeURIComponent(status.setupAgentId)}`}
              >
                Open iPhone setup
              </a>
            )}
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
        </div>
        {!ready && !settingUp && (
          <button
            type="button"
            onClick={() => void connect()}
            disabled={busy || (status === null && error === null)}
            aria-label={reauth ? 'Reconnect iPhone' : 'Connect iPhone'}
            className="shrink-0 rounded-lg bg-foreground px-3 py-2 text-xs text-background disabled:opacity-60"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : reauth ? (
              'Reconnect'
            ) : (
              'Connect iPhone'
            )}
          </button>
        )}
      </div>
    </section>
  );
}
