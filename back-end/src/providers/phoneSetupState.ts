/** One bounded encrypted setup profile/current attempt. setupState is the phase authority. */
import { openPhoneValue, sealPhoneValue, phoneCommandHash } from './phoneHarnessCredentials';
import { validSetupChecks, type SetupChecks, type SetupTarget } from './phoneSetupVerification';
import { PhoneInteractionError } from './phoneInteractionError';
export interface SetupAttempt {
  id: string;
  revision: number;
  leaseId: string;
  taskId: string;
  agentId: string;
  workflowId: string;
  floorCursor: number;
  floorAt: string;
  reasonCode?: string;
  lastRequest?: {
    requestKey: string;
    operationId: string;
    action: string;
    status: string;
    errorCode: string | null;
  };
}
export interface SetupState {
  version: 1;
  profileRevision: number;
  claimRevision: number;
  expectedAppleIdentity?: string;
  expectedGoogleIdentity?: string;
  attempt?: SetupAttempt;
  verified?: { at: string; profileRevision: number };
  verification?: SetupChecks;
  passcodeCreation?: {
    operationId: string;
    cursor: number;
    attemptId: string;
    revision: number;
    profileRevision: number;
    workflowId: string;
    providerEpoch: number;
    leaseId: string;
    confirmed: boolean;
    acknowledged?: boolean;
  };
  expectedPhone?: string | null;
}
export function setupState(encrypted: string | null): SetupState {
  if (encrypted === null) return { version: 1, profileRevision: 0, claimRevision: 0 };
  try {
    if (encrypted.length > 65536) throw new Error();
    const value = openPhoneValue<SetupState>(encrypted);
    if (
      !value ||
      value.version !== 1 ||
      (value.verification !== undefined && !validSetupChecks(value.verification)) ||
      !Number.isSafeInteger(value.profileRevision) ||
      value.profileRevision < 0 ||
      !Number.isSafeInteger(value.claimRevision) ||
      value.claimRevision < 0 ||
      (value.passcodeCreation !== undefined &&
        (!value.passcodeCreation ||
          typeof value.passcodeCreation.operationId !== 'string' ||
          !Number.isSafeInteger(value.passcodeCreation.cursor) ||
          typeof value.passcodeCreation.attemptId !== 'string' ||
          !Number.isSafeInteger(value.passcodeCreation.revision) ||
          !Number.isSafeInteger(value.passcodeCreation.profileRevision) ||
          !Number.isSafeInteger(value.passcodeCreation.providerEpoch) ||
          typeof value.passcodeCreation.workflowId !== 'string' ||
          typeof value.passcodeCreation.leaseId !== 'string' ||
          typeof value.passcodeCreation.confirmed !== 'boolean' ||
          (value.passcodeCreation.acknowledged !== undefined &&
            typeof value.passcodeCreation.acknowledged !== 'boolean'))) ||
      (value.expectedGoogleIdentity !== undefined &&
        (typeof value.expectedGoogleIdentity !== 'string' ||
          value.expectedGoogleIdentity.trim() === '' ||
          value.expectedGoogleIdentity.length > 512)) ||
      (value.expectedAppleIdentity !== undefined &&
        (typeof value.expectedAppleIdentity !== 'string' ||
          value.expectedAppleIdentity.length > 512)) ||
      (value.attempt !== undefined &&
        (typeof value.attempt.id !== 'string' ||
          !Number.isSafeInteger(value.attempt.revision) ||
          typeof value.attempt.leaseId !== 'string' ||
          typeof value.attempt.taskId !== 'string' ||
          !Number.isSafeInteger(value.attempt.floorCursor) ||
          typeof value.attempt.floorAt !== 'string'))
    )
      throw new Error();
    return value;
  } catch {
    throw new PhoneInteractionError(409, 'Phone setup state is unavailable');
  }
}
export function sealSetup(value: SetupState): string {
  if (Buffer.byteLength(JSON.stringify(value)) > 16384)
    throw new PhoneInteractionError(409, 'Phone setup state capacity reached');
  return sealPhoneValue(value);
}
export function setupIdentity(leaseId: string, revision: number): string {
  return phoneCommandHash('setup-attempt', { leaseId, revision }, 'agent');
}
export function setupAfterAttention(
  encrypted: string | null,
  leaseId: string,
  cursor: number,
  now: Date
): string | null {
  const state = setupState(encrypted);
  if (state.attempt?.leaseId !== leaseId) return encrypted;
  state.attempt.floorCursor = cursor;
  state.attempt.floorAt = now.toISOString();
  return sealSetup(state);
}
export interface SetupInput {
  action: 'defer' | 'block' | 'verify';
  attemptId: string;
  expectedRevision: number;
  expectedCursor: number;
  requestKey: string;
  reasonCode?:
    'user_constraint' | 'unsupported' | 'configuration_unavailable' | 'observed_signed_out';
  evidenceOperationIds?: string[];
  verificationTarget?: SetupTarget;
}
export const SETUP_OPERATIONS = new Set(['setup.defer', 'setup.block', 'setup.verify']);
