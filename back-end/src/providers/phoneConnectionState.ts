/** Public connection state is a projection of backend setup proofs, never a grant. */
import { createHash } from 'node:crypto';
import { verificationDto } from './phoneSetupVerification';
import {
  configurationState,
  configurationProvenanceBound,
  type SetupState,
} from './phoneSetupState';
import { PhoneInteractionError } from './phoneInteractionError';

export interface PhoneConnectionReservation {
  agentId: string;
  requestKeyHash: string;
  profileRevision: number;
  revision: number;
  workflowId?: string;
  firstExecutionRunId?: string;
}
export interface PhoneConnection {
  enabled: boolean;
  configured: boolean;
  status: 'not_connected' | 'setting_up' | 'ready' | 'needs_reauth';
  setupAgentId: string | null;
  connectionRevision: number;
}
export interface ConnectionDevice {
  enabled: boolean;
  setupState: string;
  providerEpoch: number;
}
export const connectionKey = (key: string) => createHash('sha256').update(key).digest('hex');
export function connectionAgentId(
  userId: string,
  deviceId: string,
  profile: number,
  revision: number
) {
  const h = createHash('sha256')
    .update(JSON.stringify(['iphone-connect-v1', userId, deviceId, profile, revision]))
    .digest();
  h[6] = (h[6] & 15) | 80;
  h[8] = (h[8] & 63) | 128;
  const value = h.toString('hex').slice(0, 32);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
export function currentConnection(state: SetupState) {
  return state.connection?.profileRevision === state.profileRevision ? state.connection : undefined;
}
/** Stored checks bound to the committed (or current) configuration attempt. */
export function connectionVerification(device: ConnectionDevice, state: SetupState) {
  const configuration = configurationState(state);
  return verificationDto(configuration.verification, {
    attemptId: configuration.attempt?.id,
    profileRevision: configuration.profileRevision,
    workflowId: configuration.attempt?.workflowId,
    providerEpoch: device.providerEpoch,
    expectedPhone: configuration.expectedPhone ?? null,
    expectedGoogleIdentity: configuration.expectedGoogleIdentity,
    allowGooglePasscodeException: configuration.allowGooglePasscodeException,
    floorAt: configuration.attempt?.floorAt,
    floorCursor: configuration.attempt?.floorCursor,
  });
}
export function connectionDto(
  device: ConnectionDevice | null,
  state: SetupState | null,
  accountEnabled: boolean,
  activeSetup: boolean
): PhoneConnection {
  const enabled = accountEnabled && device?.enabled === true;
  const reservation = state ? currentConnection(state) : undefined;
  const base = {
    enabled,
    configured: device !== null,
    setupAgentId: enabled ? (reservation?.agentId ?? null) : null,
    connectionRevision: state?.claimRevision ?? 0,
  };
  if (!enabled || !device || !state) return { ...base, status: 'not_connected' };
  const verification = connectionVerification(device, state);
  state = configurationState(state);
  if (
    device.setupState === 'ready' &&
    configurationProvenanceBound(state) &&
    verification.configurationReady &&
    state.verified?.profileRevision === state.profileRevision &&
    state.expectedAppleIdentity
  )
    return { ...base, status: 'ready' };
  if (state.attempt?.reasonCode === 'observed_signed_out')
    return { ...base, status: 'needs_reauth' };
  return { ...base, status: reservation && activeSetup ? 'setting_up' : 'not_connected' };
}
export function reserveConnection(
  state: SetupState,
  userId: string,
  deviceId: string,
  expectedRevision: number,
  requestKey: string,
  activeSetup: boolean
) {
  const existing = currentConnection(state);
  // An identical request retry observes its reservation even after setup steps advance the CAS.
  if (existing?.requestKeyHash === connectionKey(requestKey))
    return { reservation: existing, reused: true };
  if (state.claimRevision !== expectedRevision)
    throw new PhoneInteractionError(409, 'iPhone connection changed');
  if (existing && activeSetup) return { reservation: existing, reused: true };
  if (!state.expectedAppleIdentity || !state.expectedGoogleIdentity)
    throw new PhoneInteractionError(409, 'iPhone setup configuration is unavailable');
  if (!Number.isSafeInteger(state.claimRevision + 1))
    throw new PhoneInteractionError(409, 'iPhone connection revision exhausted');
  state.claimRevision++;
  const reservation = {
    agentId: connectionAgentId(userId, deviceId, state.profileRevision, state.claimRevision),
    requestKeyHash: connectionKey(requestKey),
    profileRevision: state.profileRevision,
    revision: state.claimRevision,
  };
  state.connection = reservation;
  // A reconnect starts verification again; it cannot keep a signed-out assertion as ready.
  delete state.attempt;
  delete state.readinessAdmission;
  return { reservation, reused: false };
}

export function connectionAgentHash(
  userId: string,
  deviceId: string,
  reservation: PhoneConnectionReservation
) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'iphone-connect-agent-v1',
        userId,
        deviceId,
        reservation.agentId,
        reservation.profileRevision,
        reservation.revision,
        reservation.requestKeyHash,
      ])
    )
    .digest('hex');
}
export function bootstrapAuthorized(
  state: SetupState,
  userId: string,
  deviceId: string,
  agentId: string,
  metadataHash: unknown,
  workflowId: string,
  firstExecutionRunId: string
) {
  const reservation = currentConnection(state);
  return (
    reservation?.agentId === agentId &&
    reservation.workflowId === workflowId &&
    reservation.firstExecutionRunId === firstExecutionRunId &&
    firstExecutionRunId !== '' &&
    metadataHash === connectionAgentHash(userId, deviceId, reservation)
  );
}

export function continuationAuthorized(
  state: SetupState,
  context: {
    leaseId: string;
    taskId: string;
    agentId: string;
    workflowId: string;
    firstExecutionRunId: string;
    providerEpoch: number;
    active: boolean;
  }
) {
  const admitted = state.readinessAdmission;
  return Boolean(
    context.active &&
    admitted &&
    state.attempt &&
    admitted.leaseId === context.leaseId &&
    admitted.taskId === context.taskId &&
    admitted.agentId === context.agentId &&
    admitted.workflowId === context.workflowId &&
    admitted.firstExecutionRunId === context.firstExecutionRunId &&
    context.firstExecutionRunId !== '' &&
    admitted.profileRevision === state.profileRevision &&
    admitted.providerEpoch === context.providerEpoch &&
    state.attempt.leaseId === context.leaseId &&
    state.attempt.taskId === context.taskId &&
    state.attempt.agentId === context.agentId &&
    state.attempt.workflowId === context.workflowId &&
    state.attempt.firstExecutionRunId === context.firstExecutionRunId &&
    state.attempt.reasonCode !== 'observed_signed_out'
  );
}
