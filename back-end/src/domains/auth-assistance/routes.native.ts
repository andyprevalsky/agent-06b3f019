import {
  NativePhoneAttentionError,
  PHONE_CRITICAL_REASONS,
  type NativePhoneInput,
  type PhoneCriticalReason,
} from '../../providers/nativePhoneAttention';
export function parseNativeCreate(record: Record<string, unknown>): NativePhoneInput {
  const text = (key: string) => {
    const value = record[key];
    if (typeof value !== 'string' || value.trim() === '' || value.length > 128)
      throw new NativePhoneAttentionError(400, `${key} is required`);
    return value;
  };
  if (record.authRealm !== 'iphone' || record.mode !== 'manual_step')
    throw new NativePhoneAttentionError(400, 'Native phone assistance requires iphone manual_step');
  if (!PHONE_CRITICAL_REASONS.includes(record.criticalReason as PhoneCriticalReason))
    throw new NativePhoneAttentionError(400, 'Invalid native phone critical reason');
  if (
    typeof record.expectedCursor !== 'number' ||
    !Number.isSafeInteger(record.expectedCursor) ||
    record.expectedCursor < 0
  )
    throw new NativePhoneAttentionError(400, 'expectedCursor must be a nonnegative integer');
  return {
    agentId: text('agentId'),
    authRealm: 'iphone',
    mode: 'manual_step',
    targetKind: 'iphone',
    browserTaskId: text('browserTaskId'),
    criticalReason: record.criticalReason as PhoneCriticalReason,
    requestKey: text('requestKey'),
    expectedCursor: record.expectedCursor,
  };
}
