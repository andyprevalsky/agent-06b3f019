/** One bounded encrypted setup profile/current attempt. setupState is the phase authority. */
import { openPhoneValue, sealPhoneValue, phoneCommandHash } from './phoneHarnessCredentials';
import { validSetupChecks, type SetupChecks, type SetupTarget } from './phoneSetupVerification';
import { PhoneInteractionError } from './phoneInteractionError';
import type { PhoneConnectionReservation } from './phoneConnectionState';
export interface SetupAttempt {
  id: string;
  revision: number;
  leaseId: string;
  taskId: string;
  agentId: string;
  workflowId: string;
  firstExecutionRunId?: string;
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
  completedConfiguration?: {
    attempt: SetupAttempt;
    verified: { at: string; profileRevision: number };
    verification: SetupChecks;
  };
  connection?: PhoneConnectionReservation;
  readinessAdmission?: {
    leaseId: string;
    taskId: string;
    agentId: string;
    workflowId: string;
    firstExecutionRunId: string;
    profileRevision: number;
    providerEpoch: number;
  };
  version: 1;
  profileRevision: number;
  claimRevision: number;
  expectedAppleIdentity?: string;
  expectedGoogleIdentity?: string;
  allowGooglePasscodeException?: boolean;
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
      (value.completedConfiguration !== undefined &&
        !validCompletedConfiguration(value.completedConfiguration)) ||
      (value.verification !== undefined && !validSetupChecks(value.verification)) ||
      (value.readinessAdmission !== undefined &&
        (!value.readinessAdmission ||
          ['leaseId', 'taskId', 'agentId', 'workflowId', 'firstExecutionRunId'].some(
            (key) =>
              typeof (value.readinessAdmission as unknown as Record<string, unknown>)[key] !==
                'string' || !(value.readinessAdmission as unknown as Record<string, unknown>)[key]
          ) ||
          !Number.isSafeInteger(value.readinessAdmission.profileRevision) ||
          value.readinessAdmission.profileRevision < 0 ||
          !Number.isSafeInteger(value.readinessAdmission.providerEpoch) ||
          value.readinessAdmission.providerEpoch < 0)) ||
      (value.connection !== undefined &&
        (!value.connection ||
          Object.keys(value.connection).some(
            (key) =>
              ![
                'agentId',
                'profileRevision',
                'requestKeyHash',
                'revision',
                'workflowId',
                'firstExecutionRunId',
              ].includes(key)
          ) ||
          (value.connection.firstExecutionRunId !== undefined &&
            (typeof value.connection.firstExecutionRunId !== 'string' ||
              !value.connection.firstExecutionRunId)) ||
          (value.connection.workflowId !== undefined &&
            (typeof value.connection.workflowId !== 'string' || !value.connection.workflowId)) ||
          typeof value.connection.agentId !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(value.connection.agentId) ||
          typeof value.connection.requestKeyHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(value.connection.requestKeyHash) ||
          !Number.isSafeInteger(value.connection.profileRevision) ||
          value.connection.profileRevision < 0 ||
          !Number.isSafeInteger(value.connection.revision) ||
          value.connection.revision < 0)) ||
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
      (value.allowGooglePasscodeException !== undefined &&
        (typeof value.allowGooglePasscodeException !== 'boolean' ||
          (value.allowGooglePasscodeException && !value.expectedGoogleIdentity))) ||
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

function validCompletedConfiguration(value: NonNullable<SetupState['completedConfiguration']>) {
  if (
    !value ||
    Object.keys(value).some((key) => !['attempt', 'verified', 'verification'].includes(key))
  )
    return false;
  const attempt = value.attempt;
  return Boolean(
    attempt &&
    ['id', 'leaseId', 'taskId', 'agentId', 'workflowId', 'firstExecutionRunId'].every(
      (key) =>
        typeof (attempt as unknown as Record<string, unknown>)[key] === 'string' &&
        Boolean((attempt as unknown as Record<string, unknown>)[key])
    ) &&
    Number.isSafeInteger(attempt.revision) &&
    attempt.revision >= 0 &&
    Number.isSafeInteger(attempt.floorCursor) &&
    attempt.floorCursor >= 0 &&
    Number.isFinite(Date.parse(attempt.floorAt)) &&
    value.verified &&
    Number.isSafeInteger(value.verified.profileRevision) &&
    value.verified.profileRevision >= 0 &&
    Number.isFinite(Date.parse(value.verified.at)) &&
    validSetupChecks(value.verification)
  );
}

/** Read-only configuration projection; active command custody still uses state.attempt. */
export function configurationState(state: SetupState): SetupState {
  const completed = state.completedConfiguration;
  return completed ? { ...state, ...completed, completedConfiguration: undefined } : state;
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
  delete state.completedConfiguration;
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
