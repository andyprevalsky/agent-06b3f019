import { SETUP_TARGETS, type SetupTarget } from '../../providers/phoneSetupVerification';
import type { SetupInput } from '../../providers/phoneSetupState';
import { IPhoneError } from './types';
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new IPhoneError(400, 'Setup body must be an object');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512)
    throw new IPhoneError(400, 'Invalid setup identifier');
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new IPhoneError(400, 'Invalid setup revision or cursor');
  return value;
}
function keys(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new IPhoneError(400, 'Unexpected setup field');
}
export function profileBody(value: unknown) {
  const body = object(value);
  keys(body, [
    'expectedProfileRevision',
    'expectedAppleIdentity',
    'expectedGoogleIdentity',
    'allowGooglePasscodeException',
  ]);
  if (
    body.allowGooglePasscodeException !== undefined &&
    typeof body.allowGooglePasscodeException !== 'boolean'
  )
    throw new IPhoneError(400, 'Invalid Google exception authorization');
  return {
    allowGooglePasscodeException: body.allowGooglePasscodeException as boolean | undefined,
    revision: integer(body.expectedProfileRevision),
    identity: text(body.expectedAppleIdentity),
    ...(body.expectedGoogleIdentity === undefined
      ? {}
      : { googleIdentity: text(body.expectedGoogleIdentity) }),
  };
}
export function setupBody(value: unknown): SetupInput {
  const body = object(value);
  keys(body, [
    'action',
    'attemptId',
    'expectedRevision',
    'expectedCursor',
    'requestKey',
    'reasonCode',
    'evidenceOperationIds',
    'verificationTarget',
  ]);
  if (body.action !== 'defer' && body.action !== 'block' && body.action !== 'verify')
    throw new IPhoneError(400, 'Invalid setup action');
  const base = {
    action: body.action,
    attemptId: text(body.attemptId),
    expectedRevision: integer(body.expectedRevision),
    expectedCursor: integer(body.expectedCursor),
    requestKey: text(body.requestKey),
  };
  if (body.action === 'verify') {
    if (
      (body.verificationTarget !== undefined &&
        !SETUP_TARGETS.includes(body.verificationTarget as SetupTarget)) ||
      body.reasonCode !== undefined ||
      !Array.isArray(body.evidenceOperationIds) ||
      body.evidenceOperationIds.length < 1 ||
      body.evidenceOperationIds.length > 8
    )
      throw new IPhoneError(400, 'Setup verification needs one to eight observations');
    const ids = body.evidenceOperationIds.map(text);
    if (new Set(ids).size !== ids.length)
      throw new IPhoneError(400, 'Duplicate setup observations');
    return {
      ...base,
      action: 'verify',
      evidenceOperationIds: ids,
      ...(body.verificationTarget !== undefined
        ? { verificationTarget: body.verificationTarget as SetupTarget }
        : {}),
    };
  }
  if (
    body.verificationTarget !== undefined ||
    body.evidenceOperationIds !== undefined ||
    (body.action === 'defer'
      ? body.reasonCode !== 'user_constraint'
      : !['unsupported', 'configuration_unavailable', 'observed_signed_out'].includes(
          String(body.reasonCode)
        ))
  )
    throw new IPhoneError(400, 'Invalid setup reason');
  return { ...base, action: body.action, reasonCode: body.reasonCode as SetupInput['reasonCode'] };
}
