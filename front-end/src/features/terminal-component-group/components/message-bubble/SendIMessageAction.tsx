/**
 * Inline "Send via Mac iMessage" affordance shown on attention-request tool
 * cards with `onSuccess === 'sendSmsThroughIMessage'`.
 *
 * STATE MACHINE: see `useSendIMessage`.
 */
import { Button } from '@/components/ui/button';
import { useSendIMessage, type AttentionAction } from './useSendIMessage';

interface SendIMessageActionProps {
  actionMetadata: Record<string, unknown>;
}

export function SendIMessageAction({ actionMetadata }: SendIMessageActionProps) {
  const meta = actionMetadata as AttentionAction;
  const { actionLoading, handleClick } = useSendIMessage(meta);

  return (
    <div className="rounded-md border border-dashed border-primary/40 bg-primary/5 p-3 space-y-2">
      <p className="text-xs text-muted-foreground">
        Send this via your Mac to unblock the agent.
      </p>
      <div className="text-xs text-muted-foreground space-y-1">
        {meta.to && (
          <p>
            <span className="font-semibold">To:</span> {meta.to}
          </p>
        )}
        {meta.message && (
          <p className="whitespace-pre-wrap break-words">
            <span className="font-semibold">Message:</span> {meta.message}
          </p>
        )}
      </div>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void handleClick()}
        disabled={actionLoading}
      >
        {actionLoading ? 'Sending...' : 'Send via Mac iMessage'}
      </Button>
    </div>
  );
}
