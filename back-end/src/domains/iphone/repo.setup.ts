import type { Agent } from '@prisma/client';
/** Caller owns device lock. Only the active exact task can see the configured identity. */
import {
  setupState,
  sealSetup,
  setupIdentity,
  type SetupState,
  type SetupAttempt,
  configurationState,
  configurationProvenanceBound,
} from '../../providers/phoneSetupState';
import type { Transaction, IPhoneDevice, IPhoneLease } from './types';
import { verificationDto, proofCurrent } from '../../providers/phoneSetupVerification';
import { currentConnection } from '../../providers/phoneConnectionState';
import { databaseNow } from './repo.clock';

export function setupDto(device: IPhoneDevice, state: SetupState, lease: IPhoneLease) {
  const configuration = configurationState(state);
  const active =
    lease.status === 'ACTIVE' &&
    lease.releaseRequestedAt === null &&
    state.attempt?.leaseId === lease.id &&
    state.attempt.taskId === lease.browserTaskId;
  const verification = verificationDto(
    configuration.verification,
    {
      attemptId: configuration.attempt?.id,
      profileRevision: state.profileRevision,
      workflowId: configuration.attempt?.workflowId,
      providerEpoch: device.providerEpoch,
      expectedPhone: state.expectedPhone ?? null,
      expectedGoogleIdentity: state.expectedGoogleIdentity,
      allowGooglePasscodeException: state.allowGooglePasscodeException,
      floorAt: configuration.attempt?.floorAt,
      floorCursor: configuration.attempt?.floorCursor,
    },
    {
      value: state.verification,
      context: {
        attemptId: state.attempt?.id,
        profileRevision: state.profileRevision,
        workflowId: state.attempt?.workflowId,
        providerEpoch: device.providerEpoch,
        expectedPhone: state.expectedPhone ?? null,
        floorAt: state.attempt?.floorAt,
        floorCursor: state.attempt?.floorCursor,
      },
    }
  );
  const required =
    !configurationProvenanceBound(state) ||
    !verification.configurationReady ||
    device.setupState !== 'ready' ||
    configuration.verified?.profileRevision !== state.profileRevision ||
    state.expectedAppleIdentity === undefined;
  return {
    required,
    state: device.setupState,
    attemptId: active ? state.attempt!.id : null,
    revision: active ? state.attempt!.revision : state.claimRevision,
    profileRevision: state.profileRevision,
    ...(active && state.allowGooglePasscodeException === true
      ? { googlePasscodeExceptionAllowed: true }
      : {}),
    identityVerified: configuration.verified?.profileRevision === state.profileRevision,
    ...(active && state.expectedGoogleIdentity !== undefined
      ? { expectedGoogleAccountIdentifier: state.expectedGoogleIdentity }
      : {}),
    verification: {
      ...verification,
      ...(active && state.expectedPhone !== undefined && state.expectedPhone !== null
        ? { expectedReceiveAddress: state.expectedPhone }
        : {}),
    },
    ...(active && required && state.expectedAppleIdentity !== undefined
      ? { expectedAccountIdentifier: state.expectedAppleIdentity }
      : {}),
    ...(active && state.attempt?.reasonCode !== undefined
      ? { reasonCode: state.attempt.reasonCode }
      : {}),
    ...(state.verified ? { lastVerifiedAt: state.verified.at } : {}),
    ...(active && state.attempt?.lastRequest ? { lastRequest: state.attempt.lastRequest } : {}),
  };
}
export async function ensureSetup(tx: Transaction, deviceId: string, lease: IPhoneLease) {
  let device = await tx.iPhoneDevice.findUniqueOrThrow({ where: { id: deviceId } });
  const state = setupState(device.setupEncrypted);
  const agent =
    lease.status === 'ACTIVE' ? await tx.agent.findUnique({ where: { id: lease.agentId } }) : null;
  const owner =
    lease.status === 'ACTIVE'
      ? await tx.user.findUnique({ where: { userId: lease.userId }, select: { phone: true } })
      : null;
  const expectedPhone = owner?.phone ?? null;
  const generation = agent?.temporalWorkflowId ?? agent?.id;
  const configured =
    device.setupState === 'ready' &&
    !setupDto(device, state, lease).required &&
    state.expectedPhone === expectedPhone &&
    configurationProvenanceBound(state);
  if (
    lease.status === 'ACTIVE' &&
    lease.releaseRequestedAt === null &&
    lease.browserTaskId !== null &&
    (state.attempt?.leaseId !== lease.id ||
      state.attempt.workflowId !== generation ||
      state.attempt.firstExecutionRunId !== (agent?.temporalFirstExecutionRunId ?? undefined) ||
      state.attempt.taskId !== lease.browserTaskId ||
      state.expectedPhone !== expectedPhone)
  ) {
    const now = await databaseNow(tx);
    const carryFrom = configured ? undefined : actorAttempt(state, lease, agent, expectedPhone);
    if (!configured) delete state.completedConfiguration;
    if (configured && !state.completedConfiguration)
      state.completedConfiguration = structuredClone({
        attempt: state.attempt!,
        verified: state.verified!,
        verification: state.verification!,
      });
    delete state.readinessAdmission;
    await captureReadiness(tx, device, state, lease, agent, generation, expectedPhone);
    if (state.expectedPhone !== expectedPhone) delete state.connection;
    state.expectedPhone = expectedPhone;
    state.claimRevision++;
    state.attempt = nextAttempt(state, lease, agent, generation!, now);
    if (carryFrom) carryAcrossLease(state, carryFrom, device.providerEpoch);
    device = await tx.iPhoneDevice.update({
      where: { id: device.id },
      data: {
        setupEncrypted: sealSetup(state),
        setupState: configured
          ? 'ready'
          : state.expectedAppleIdentity !== undefined
            ? 'in_progress'
            : 'blocked',
      },
    });
  }
  if (
    device.setupState === 'ready' &&
    !setupDto(device, state, lease).verification.configurationReady
  ) {
    device = await tx.iPhoneDevice.update({
      where: { id: device.id },
      data: { setupState: 'in_progress' },
    });
  }
  return { device, state, dto: setupDto(device, state, lease) };
}

function nextAttempt(
  state: SetupState,
  lease: IPhoneLease,
  agent: Agent | null,
  generation: string,
  now: Date
): SetupAttempt {
  return {
    id: setupIdentity(lease.id, state.claimRevision),
    revision: state.claimRevision,
    leaseId: lease.id,
    taskId: lease.browserTaskId!,
    agentId: lease.agentId,
    workflowId: generation,
    ...(agent?.temporalFirstExecutionRunId !== undefined &&
    agent.temporalFirstExecutionRunId !== null &&
    agent.temporalFirstExecutionRunId !== ''
      ? { firstExecutionRunId: agent.temporalFirstExecutionRunId }
      : {}),
    floorCursor: lease.actionCursor,
    floorAt: now.toISOString(),
    ...(state.expectedAppleIdentity === undefined
      ? { reasonCode: 'configuration_unavailable' }
      : {}),
  };
}

/** One connection reservation's setup actor and execution chain re-acquiring the phone. */
function actorAttempt(
  state: SetupState,
  lease: IPhoneLease,
  agent: Agent | null,
  expectedPhone: string | null
) {
  const previous = state.attempt;
  const reservation = currentConnection(state);
  const firstRun = agent?.temporalFirstExecutionRunId ?? '';
  const generation = agent?.temporalWorkflowId ?? agent?.id ?? '';
  const same = Boolean(
    previous &&
    reservation &&
    firstRun !== '' &&
    generation !== '' &&
    previous.reasonCode !== 'observed_signed_out' &&
    state.expectedPhone === expectedPhone &&
    reservation.agentId === lease.agentId &&
    reservation.workflowId === generation &&
    reservation.firstExecutionRunId === firstRun &&
    previous.agentId === lease.agentId &&
    previous.taskId === lease.browserTaskId &&
    previous.workflowId === generation &&
    previous.firstExecutionRunId === firstRun
  );
  return same ? previous : undefined;
}

/** Rebind proofs still current on the actor's earlier lease to its new attempt; each proof
 * keeps its observation time and epoch, and stale or runtime proofs are never revived. */
function carryAcrossLease(state: SetupState, previous: SetupAttempt, providerEpoch: number) {
  const checks = state.verification?.checks;
  if (!checks || !state.attempt) return;
  const prior = {
    attemptId: previous.id,
    profileRevision: state.profileRevision,
    workflowId: previous.workflowId,
    providerEpoch,
    expectedPhone: state.expectedPhone ?? null,
    floorAt: previous.floorAt,
    floorCursor: previous.floorCursor,
  };
  delete checks.runtime;
  for (const proof of Object.values(checks)) {
    if (!proofCurrent(proof, prior)) continue;
    proof.attemptId = state.attempt.id;
    proof.workflowId = state.attempt.workflowId;
    proof.floorCursor = state.attempt.floorCursor;
    proof.carriedAt = state.attempt.floorAt;
  }
}

async function captureReadiness(
  tx: Transaction,
  device: IPhoneDevice,
  state: SetupState,
  lease: IPhoneLease,
  agent: Agent | null,
  generation: string | undefined,
  expectedPhone: string | null
) {
  if (lease.browserTaskId === null) return;
  if (
    device.setupState === 'ready' &&
    setupDto(device, state, lease).verification.configurationReady &&
    state.verified?.profileRevision === state.profileRevision &&
    state.expectedPhone === expectedPhone &&
    agent !== null &&
    agent.temporalFirstExecutionRunId !== null &&
    agent.temporalFirstExecutionRunId !== '' &&
    configurationProvenanceBound(state)
  ) {
    state.readinessAdmission = {
      leaseId: lease.id,
      taskId: lease.browserTaskId,
      agentId: lease.agentId,
      workflowId: generation!,
      firstExecutionRunId: agent.temporalFirstExecutionRunId,
      profileRevision: state.profileRevision,
      providerEpoch: device.providerEpoch,
    };
  }
}
