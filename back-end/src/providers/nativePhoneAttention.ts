/** Trusted persisted native target, never inferred from URLs, OCR or user text. */
export { PhoneInteractionError as NativePhoneAttentionError } from './phoneInteractionError';
export type NativePhoneTarget = {
  kind: 'iphone';
  browserTaskId: string;
  leaseId: string;
};
export const PHONE_CRITICAL_REASONS = [
  'password',
  'verification_code',
  'device_passcode',
  'manual_verification',
] as const;
export type PhoneCriticalReason = (typeof PHONE_CRITICAL_REASONS)[number];
export interface NativePhoneInput {
  agentId: string;
  authRealm: 'iphone';
  mode: 'manual_step';
  targetKind: 'iphone';
  browserTaskId: string;
  criticalReason: PhoneCriticalReason;
  requestKey: string;
  expectedCursor: number;
}
export function phoneMetadataObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function getNativePhoneTarget(metadata: unknown): NativePhoneTarget | null {
  const target = phoneMetadataObject(phoneMetadataObject(metadata).target);
  return target.kind === 'iphone' &&
    typeof target.browserTaskId === 'string' &&
    target.browserTaskId !== '' &&
    typeof target.leaseId === 'string' &&
    target.leaseId !== ''
    ? { kind: 'iphone', browserTaskId: target.browserTaskId, leaseId: target.leaseId }
    : null;
}
export function isNativePhoneAttention(metadata: unknown): boolean {
  const root = phoneMetadataObject(metadata);
  return (
    phoneMetadataObject(root.target).kind === 'iphone' ||
    phoneMetadataObject(phoneMetadataObject(root.authAssistance).target).kind === 'iphone'
  );
}
