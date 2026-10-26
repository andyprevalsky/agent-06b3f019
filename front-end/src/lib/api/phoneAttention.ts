/** Native handoff identity is public; authority comes only from authenticated request reads. */
export interface PhoneAttentionTarget {
  kind: 'iphone';
  browserTaskId: string;
  leaseId: string;
}
export type PhoneCriticalReason =
  'password' | 'verification_code' | 'device_passcode' | 'manual_verification';
export interface PhoneAttention {
  id: string;
  agentId: string;
  target: PhoneAttentionTarget;
  criticalReason: PhoneCriticalReason;
  completedAt: string | null;
}
export function readPhoneTarget(value: unknown): PhoneAttentionTarget | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const t = value as Record<string, unknown>;
  return t.kind === 'iphone' &&
    typeof t.browserTaskId === 'string' &&
    !!t.browserTaskId &&
    typeof t.leaseId === 'string' &&
    !!t.leaseId
    ? { kind: 'iphone', browserTaskId: t.browserTaskId, leaseId: t.leaseId }
    : undefined;
}
export function readCriticalReason(value: unknown): PhoneCriticalReason | undefined {
  return ['password', 'verification_code', 'device_passcode', 'manual_verification'].includes(
    String(value),
  )
    ? (value as PhoneCriticalReason)
    : undefined;
}
export function readPhoneAttention(value: unknown): PhoneAttention | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>,
    target = readPhoneTarget(r.target),
    criticalReason = readCriticalReason(r.criticalReason);
  if (
    r.mode !== 'manual_step' ||
    !target ||
    !criticalReason ||
    typeof r.id !== 'string' ||
    typeof r.agentId !== 'string' ||
    (r.completedAt !== null && typeof r.completedAt !== 'string')
  )
    return null;
  return {
    id: r.id,
    agentId: r.agentId,
    target,
    criticalReason,
    completedAt: r.completedAt as string | null,
  };
}
