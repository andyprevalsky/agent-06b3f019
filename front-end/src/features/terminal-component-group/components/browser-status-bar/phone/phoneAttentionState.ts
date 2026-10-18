/** Metadata and URLs wake a request lookup; neither is authorization for phone input. */
import { getQueryParams } from '@/lib/url';
import { readPhoneTarget, type PhoneAttention } from '@/lib/api/phoneAttention';
import type { PhoneLease } from '@/lib/api/iphone';
import type { Message } from '../../../hooks';
export function phoneAttentionCandidate(
  taskId: string,
  agentId: string | null | undefined,
  messages: Message[],
) {
  const query = getQueryParams(),
    linked = query.get('attention-request-id');
  if (linked)
    return query.get('agent-id') === agentId && query.get('browser-id') === taskId ? linked : '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const meta = messages[i].metadata;
    const raw = meta?.requestUserAuthentication;
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>,
      target = readPhoneTarget(r.target);
    if (target?.browserTaskId !== taskId) continue;
    return meta.toolStatus === 'IN_PROGRESS' && typeof r.requestId === 'string' ? r.requestId : '';
  }
  return '';
}
export function matchesPhoneAttention(
  request: PhoneAttention | null | undefined,
  lease: PhoneLease | null | undefined,
) {
  return (
    !!request &&
    request.completedAt === null &&
    !!lease &&
    request.id === lease.attentionRequestId &&
    request.agentId === lease.agentId &&
    request.target.browserTaskId === lease.browserTaskId &&
    request.target.leaseId === lease.id
  );
}
