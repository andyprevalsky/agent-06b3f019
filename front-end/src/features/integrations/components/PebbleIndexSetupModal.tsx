/**
 * STATE MACHINE: PebbleIndexSetupModal
 *
 *   [CLOSED] --open--> [LOADING] --POST /api/index01/credentials--> [READY]
 *                         |                                           |
 *                         +--error--> [ERROR] --Try again--> [LOADING]
 *   [READY] --Copy on a value--> [READY] (that value shows "Copied" for 1.5 s)
 *   [any OPEN state] --Close / Done / Escape--> [CLOSED]
 *
 * System context:
 *   Integrations row "Pebble Index 01" --Connect--> this modal
 *     --> backend mints (first time) / returns the user's dedicated "Index 01"
 *         Rose API key + the webhook URL --> the user types them into the
 *         Index app's Hold & Talk webhook screen --> each recording is POSTed to
 *         /api/index01/webhook, which starts a plan-mode rose-1-ultra agent.
 *   The key is the user's own secret: it is only fetched while the modal is open.
 */

import { useEffect, useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';

import pebbleIndexIcon from '@/assets/pebble-index-icon.png';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

import { useIndex01Setup } from '../hooks/useIndex01Setup';
import type { Index01Credentials } from '../types';

const COPIED_MS = 1_500;

interface PebbleIndexSetupModalProps {
  open: boolean;
  onClose: () => void;
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => setCopied(true));
  };
  return (
    <div className="mt-1.5 flex items-center gap-2 rounded-md border border-border bg-background/60 px-2.5 py-1.5">
      <span className="shrink-0 text-[11px] font-medium text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 break-all text-xs" data-testid={`pebble-value-${label}`}>
        {value}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${label}`}
        className="flex shrink-0 items-center gap-1 text-xs font-semibold text-[#e8507f] hover:opacity-80 dark:text-[#ff7aa2]"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold">
        {n}
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{title}</p>
        {children}
      </div>
    </li>
  );
}

function SetupSteps({ credentials }: { credentials: Index01Credentials }) {
  return (
    <ol className="space-y-4" data-testid="pebble-setup-steps">
      <Step n={1} title="Open the Index app → Settings → Ring Button → Hold & Talk">
        <p className="mt-1 text-xs text-muted-foreground">
          Pick <b>Webhook only</b> so Rose handles every recording. To keep your current Index agent
          too, leave it and switch on <b>Also send to webhook</b>, then tap it to set up.
        </p>
      </Step>
      <Step n={2} title="Webhook URL">
        <CopyValue label="URL" value={credentials.webhook_url} />
      </Step>
      <Step n={3} title="What to send: Both">
        <p className="mt-1 text-xs text-muted-foreground">
          Rose starts an agent from the transcription and keeps the recording so it can be
          re-transcribed later. Transcription alone also works.
        </p>
      </Step>
      <Step n={4} title="Headers → Add header">
        <CopyValue label="Name" value={credentials.header_name} />
        <CopyValue label="Value" value={credentials.header_value} />
        <p className="mt-1 text-xs text-muted-foreground">
          This value is your private key: don't share it.
        </p>
      </Step>
      <Step n={5} title="Leave “Sign requests” off, then tap Save">
        <p className="mt-1 text-xs text-muted-foreground">
          “Send test event” confirms the connection without starting an agent.
        </p>
      </Step>
      <Step n={6} title="Hold the ring and talk">
        <p className="mt-1 text-xs text-muted-foreground">
          Each recording starts a Rose agent in plan mode (rose-1-ultra). It appears in your agents
          list.
        </p>
      </Step>
    </ol>
  );
}

export default function PebbleIndexSetupModal({ open, onClose }: PebbleIndexSetupModalProps) {
  const { state, reload } = useIndex01Setup(open);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
        <div className="flex items-center gap-3">
          <img
            src={pebbleIndexIcon}
            alt=""
            aria-hidden="true"
            className="h-9 w-9 rounded-lg bg-white"
          />
          <div className="min-w-0">
            <DialogTitle className="text-base">Connect Pebble Index 01</DialogTitle>
            <DialogDescription className="text-xs">
              Enter these in the Index app: every recording becomes a Rose agent.
            </DialogDescription>
          </div>
        </div>
        {state.status === 'loading' && (
          <div className="flex items-center justify-center py-8" role="status">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {state.status === 'error' && (
          <div className="space-y-2" role="alert">
            <p className="text-sm text-destructive">{state.message}</p>
            <button type="button" onClick={reload} className="text-sm font-semibold underline">
              Try again
            </button>
          </div>
        )}
        {state.status === 'ready' && <SetupSteps credentials={state.credentials} />}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Done
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
