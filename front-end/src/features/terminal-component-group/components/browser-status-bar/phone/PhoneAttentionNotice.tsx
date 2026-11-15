/** [CHECKING|STALE|COMPLETING|COMPLETE|RESENDING] -> constant in-layout status; never provider error/result text. */
import type { PhoneLease } from '@/lib/api/iphone';
import type { PhoneAttentionModel } from './usePhoneAttention';
import { matchesPhoneAttention } from './phoneAttentionState';
import { usePhoneResendCode } from './usePhoneResendCode';
export function PhoneAttentionNotice({
  attention,
  lease,
}: {
  attention?: PhoneAttentionModel;
  lease?: PhoneLease | null;
}) {
  const resending = usePhoneResendCode(
    attention?.request?.agentId,
    attention?.request?.target.browserTaskId ?? '',
    null,
  ).active;
  if (!attention || (!attention.id && !attention.error && !attention.request?.completedAt))
    return null;
  const message =
    attention.error ||
    attention.notice ||
    (attention.request?.completedAt
      ? resending
        ? 'Agent is resending the code on the phone.'
        : 'Authentication complete. Agent will verify sign-in.'
      : attention.completing
        ? 'Checking authentication completion. No input will be replayed.'
        : attention.request && lease && !matchesPhoneAttention(attention.request, lease)
          ? 'This phone authentication request does not match the current phone reservation.'
          : !attention.request
            ? 'Checking phone authentication request…'
            : '');
  return message ? (
    <p
      role="status"
      aria-label="Phone authentication status"
      className="flex-none px-3 py-1 text-xs text-amber-200"
    >
      {message}
    </p>
  ) : null;
}
