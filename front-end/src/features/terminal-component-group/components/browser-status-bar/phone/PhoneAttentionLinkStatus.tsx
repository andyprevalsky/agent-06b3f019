/** [MISSING LINKED TASK] -> one authenticated status read -> [PENDING|STALE|COMPLETE], never another browser. */
import { getQueryParams } from '@/lib/url';
import { usePhoneAttention } from './usePhoneAttention';
export function PhoneAttentionLinkStatus({ taskId }: { taskId: string }) {
  const attention = usePhoneAttention(taskId, getQueryParams().get('agent-id'), [], true, false);
  return (
    <p
      role="status"
      aria-label="Phone authentication link status"
      className="rounded border border-border p-3 text-sm"
    >
      {attention.error ||
        (attention.request?.completedAt
          ? 'Authentication complete. Agent will verify sign-in.'
          : attention.request
            ? 'The phone task is unavailable. Open this exact pending request again after the agent finishes loading.'
            : 'Checking phone authentication request…')}
    </p>
  );
}
