/** [IDLE] Resend code -> [SENDING] spinner -> [DONE] 60 s cooldown -> [IDLE]; no typing. */
import { Loader2 } from 'lucide-react';
import { usePhoneResendCode } from './usePhoneResendCode';

export function PhoneResendCodeButton({
  agentId,
  taskId,
  pendingRequestId,
  disabled = false,
  className,
}: {
  agentId: string | null | undefined;
  taskId: string;
  pendingRequestId: string | null | undefined;
  disabled?: boolean;
  className?: string;
}) {
  const resend = usePhoneResendCode(agentId, taskId, pendingRequestId);
  if (!resend.active && !pendingRequestId) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        aria-label={
          resend.phase === 'sending'
            ? 'Resending code'
            : resend.phase === 'done'
              ? `Code resent, available again in ${resend.cooldownSeconds} seconds`
              : 'Resend code'
        }
        aria-busy={resend.phase === 'sending'}
        disabled={disabled || !resend.available}
        onClick={() => void resend.press()}
        className={
          className ??
          'inline-flex min-h-11 items-center gap-1 rounded border border-white/30 px-2 text-sm disabled:opacity-50'
        }
      >
        {resend.phase === 'sending' && (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        )}
        {resend.phase === 'sending'
          ? 'Resending…'
          : resend.phase === 'done'
            ? 'Done'
            : 'Resend code'}
      </button>
      {resend.notice && (
        <span role="status" className="text-xs text-amber-200">
          {resend.notice}
        </span>
      )}
    </span>
  );
}
