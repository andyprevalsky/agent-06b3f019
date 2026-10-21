/** [CHECKING|STALE|COMPLETING|COMPLETE] -> constant in-layout status; never provider error/result text. */
import type { PhoneLease } from '@/lib/api/iphone';
import type { PhoneAttentionModel } from './usePhoneAttention';
import { matchesPhoneAttention } from './phoneAttentionState';
export function PhoneAttentionNotice({
  attention,
  lease,
}: {
  attention?: PhoneAttentionModel;
  lease?: PhoneLease | null;
}) {
  if (!attention || (!attention.id && !attention.error)) return null;
  const message =
    attention.error ||
    attention.notice ||
    (attention.request?.completedAt
      ? 'Authentication complete. Agent will verify sign-in.'
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
