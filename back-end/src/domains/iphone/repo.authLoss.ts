import type { Agent } from '@prisma/client';
import type { Transaction, IPhoneDevice, IPhoneLease, IPhoneOperation } from './types';
import { authLossObservation } from '../../providers/phoneAuthLossPrivacy';
/** Exact native evidence fences; semantic classification occurs outside transactions. */
import { createHash } from 'node:crypto';
import { setupState, sealSetup, type SetupState } from '../../providers/phoneSetupState';
import { openPhoneValue, sealPhoneValue } from '../../providers/phoneHarnessCredentials';
import { nativeMessagesWitness } from '../../providers/phoneNativeAppWitness';
import { lockAgentWorkflowGeneration } from '../../providers/workflowGeneration';
import { privacyState, internalPhoneObservation } from './privacy';
import { databaseNow } from './repo.clock';
import * as leases from './repo';
import type { CommandClaim } from './types.operations';
import type { ImessageAuthLossResult } from '../../providers/phoneAuthLoss';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function authLossEvidence(claim: CommandClaim, observed: unknown) {
  return leases.transaction(async (tx) => {
    const { device, enabled } = await leases.lockedDevice(tx, claim.lease.userId);
    if (
      !enabled ||
      device.providerState === 'CLOSING' ||
      privacyState(device.privateInputEncrypted).active
    )
      return null;
    await lockAgentWorkflowGeneration(tx, claim.lease.agentId);
    const lease = await tx.iPhoneLease.findUnique({ where: { id: claim.lease.id } });
    const agent = await tx.agent.findFirst({
      where: { id: claim.lease.agentId, userId: claim.lease.userId, deletedAt: null },
    });
    const command = await tx.iPhoneOperation.findUnique({ where: { id: claim.command.id } });
    const state = setupState(device.setupEncrypted);
    const now = await databaseNow(tx);
    const expectedPhone = await accountPhone(tx, claim.lease.userId);
    if (
      !lease ||
      agent === null ||
      agent.temporalFirstExecutionRunId === null ||
      agent.temporalFirstExecutionRunId === '' ||
      !command ||
      command.operation !== 'screen.text' ||
      command.actor !== 'agent' ||
      command.state !== 'RUNNING' ||
      command.resultEncrypted !== null ||
      command.deadlineAt <= now ||
      command.providerEpoch !== device.providerEpoch ||
      lease.deviceId !== device.id ||
      lease.userId !== claim.lease.userId ||
      lease.agentId !== agent.id ||
      lease.status !== 'ACTIVE' ||
      lease.releaseRequestedAt !== null ||
      lease.controlOwner !== 'agent' ||
      lease.attentionRequestId !== null ||
      lease.actionCursor !== command.cursor ||
      state.attempt?.leaseId !== lease.id ||
      state.attempt.taskId !== lease.browserTaskId ||
      command.cursor <= state.attempt.floorCursor ||
      state.attempt.workflowId !== (agent.temporalWorkflowId ?? agent.id) ||
      state.attempt.firstExecutionRunId !== agent.temporalFirstExecutionRunId ||
      state.expectedPhone !== expectedPhone
    )
      return null;
    const witness = await tx.iPhoneOperation.findFirst({
      where: {
        leaseId: lease.id,
        deviceId: device.id,
        cursor: command.cursor - 1,
        actor: 'agent',
        state: 'SUCCEEDED',
        providerEpoch: device.providerEpoch,
        operation: { in: ['apps.launch', 'apps.current'] },
      },
    });
    if (
      witness === null ||
      witness.resultEncrypted === null ||
      witness.resultEncrypted === '' ||
      !witness.completedAt ||
      witness.completedAt < new Date(state.attempt.floorAt) ||
      witness.completedAt > now ||
      now.getTime() - witness.completedAt.getTime() > 120000 ||
      !nativeMessagesWitness(
        witness.operation,
        openPhoneValue(witness.requestEncrypted),
        openPhoneValue(witness.resultEncrypted)
      )
    )
      return null;
    return stageAuthLossEvidence(
      tx,
      { device, lease, agent, command, state, now },
      witness,
      observed
    );
  });
}
export type AuthLossEvidence = NonNullable<Awaited<ReturnType<typeof authLossEvidence>>>;
export async function finishAuthLoss(proof: AuthLossEvidence, result: ImessageAuthLossResult) {
  return leases.transaction(async (tx) => {
    const { device, enabled } = await leases.lockedDevice(tx, proof.userId);
    await lockAgentWorkflowGeneration(tx, proof.agentId);
    const agent = await tx.agent.findFirst({
      where: { id: proof.agentId, userId: proof.userId, deletedAt: null },
    });
    const lease = await tx.iPhoneLease.findUnique({ where: { id: proof.leaseId } });
    const command = await tx.iPhoneOperation.findUnique({ where: { id: proof.commandId } });
    const witness = await tx.iPhoneOperation.findFirst({
      where: { leaseId: proof.leaseId, deviceId: proof.deviceId, cursor: proof.cursor - 1 },
    });
    const state = setupState(device.setupEncrypted);
    const now = await databaseNow(tx);
    const owner = await tx.user.findUnique({
      where: { userId: proof.userId },
      select: { phone: true },
    });
    if (
      result.status !== 'signed_out' ||
      !enabled ||
      device.providerState === 'CLOSING' ||
      !agent ||
      !lease ||
      command === null ||
      command.resultEncrypted === null ||
      command.resultEncrypted === '' ||
      privacyState(device.privateInputEncrypted).active ||
      lease.status !== 'ACTIVE' ||
      lease.releaseRequestedAt !== null ||
      lease.controlOwner !== 'agent' ||
      lease.attentionRequestId !== null ||
      lease.actionCursor !== proof.cursor ||
      lease.deviceId !== proof.deviceId ||
      lease.userId !== proof.userId ||
      lease.agentId !== proof.agentId ||
      state.profileRevision !== proof.profileRevision ||
      state.claimRevision !== proof.claimRevision ||
      state.expectedPhone !== (owner?.phone ?? null) ||
      state.expectedPhone !== proof.expectedPhone ||
      device.providerEpoch !== proof.providerEpoch ||
      command.state !== 'RUNNING' ||
      hash(device.privateInputEncrypted ?? '') !== proof.privacySha ||
      now.getTime() - Date.parse(proof.capturedAt) > 120000 ||
      witness === null ||
      witness.resultEncrypted === null ||
      witness.resultEncrypted === '' ||
      witness.operation !== proof.witnessOperation ||
      witness.state !== 'SUCCEEDED' ||
      witness.actor !== 'agent' ||
      witness.providerEpoch !== proof.providerEpoch ||
      witness.completedAt?.toISOString() !== proof.witnessCompletedAt ||
      hash(witness.resultEncrypted) !== proof.witnessSha ||
      hash(witness.requestEncrypted) !== proof.witnessRequestSha ||
      command.operation !== 'screen.text' ||
      command.actor !== 'agent' ||
      command.leaseId !== proof.leaseId ||
      command.deviceId !== proof.deviceId ||
      command.cursor !== proof.cursor ||
      command.providerEpoch !== proof.providerEpoch ||
      hash(command.resultEncrypted) !== proof.resultSha ||
      command.deadlineAt.toISOString() !== proof.deadlineAt ||
      command.deadlineAt <= now ||
      agent.temporalWorkflowId !== proof.workflowId ||
      agent.temporalFirstExecutionRunId !== proof.firstExecutionRunId ||
      state.attempt?.leaseId !== proof.leaseId ||
      state.attempt.agentId !== proof.agentId ||
      state.attempt.taskId !== lease.browserTaskId ||
      state.attempt.workflowId !== proof.workflowId ||
      state.attempt.firstExecutionRunId !== proof.firstExecutionRunId
    )
      return false;
    return commitAuthRevocation(tx, device.id, state, proof.cursor, now);
  });
}

interface AuthLossContext {
  device: IPhoneDevice;
  lease: IPhoneLease;
  agent: Agent;
  command: IPhoneOperation;
  state: SetupState;
  now: Date;
}
async function stageAuthLossEvidence(
  tx: Transaction,
  context: AuthLossContext,
  witness: IPhoneOperation,
  observed: unknown
) {
  const { device, lease, agent, command, state, now } = context;
  if (
    witness.resultEncrypted === null ||
    witness.completedAt === null ||
    agent.temporalFirstExecutionRunId === null
  )
    return null;
  const observation = internalPhoneObservation(
    { ...command, state: 'SUCCEEDED' },
    observed,
    device.privateInputEncrypted,
    {}
  );
  const encrypted = sealPhoneValue(observation);
  const evidence = [
    {
      operationId: witness.requestKey,
      cursor: witness.cursor,
      result: { operation: witness.operation, nativeBundle: 'com.apple.MobileSMS' },
    },
    {
      operationId: command.requestKey,
      cursor: command.cursor,
      result: authLossObservation(observation),
    },
  ];
  if (Buffer.byteLength(JSON.stringify(evidence)) > 32768) return null;
  const staged = await tx.iPhoneOperation.updateMany({
    where: { id: command.id, state: 'RUNNING', resultEncrypted: null },
    data: { resultEncrypted: encrypted },
  });
  if (staged.count !== 1) return null;
  return {
    userId: lease.userId,
    agentId: agent.id,
    deviceId: device.id,
    leaseId: lease.id,
    commandId: command.id,
    profileRevision: state.profileRevision,
    claimRevision: state.claimRevision,
    expectedPhone: state.expectedPhone ?? null,
    workflowId: agent.temporalWorkflowId ?? agent.id,
    firstExecutionRunId: agent.temporalFirstExecutionRunId,
    providerEpoch: device.providerEpoch,
    cursor: command.cursor,
    resultSha: hash(encrypted),
    privacySha: hash(device.privateInputEncrypted ?? ''),
    capturedAt: now.toISOString(),
    witnessSha: hash(witness.resultEncrypted),
    witnessOperation: witness.operation,
    witnessCompletedAt: witness.completedAt.toISOString(),
    witnessRequestSha: hash(witness.requestEncrypted),
    deadlineAt: command.deadlineAt.toISOString(),
    evidence,
    timeoutMs: Math.max(0, Math.floor(command.deadlineAt.getTime() - now.getTime())),
  };
}

async function commitAuthRevocation(
  tx: Transaction,
  deviceId: string,
  state: SetupState,
  cursor: number,
  now: Date
) {
  if (state.attempt === undefined) return false;
  state.claimRevision++;
  delete state.verified;
  delete state.connection;
  delete state.readinessAdmission;
  state.attempt.revision = state.claimRevision;
  state.attempt.reasonCode = 'observed_signed_out';
  state.attempt.floorAt = now.toISOString();
  state.attempt.floorCursor = cursor;
  for (const target of ['apple_account', 'imessage'] as const) {
    const p = state.verification?.checks[target];
    if (p) {
      p.status = 'disabled';
      p.observedAt = now.toISOString();
    }
  }
  await tx.iPhoneDevice.update({
    where: { id: deviceId },
    data: { setupState: 'blocked', setupEncrypted: sealSetup(state) },
  });
  return true;
}

async function accountPhone(tx: Transaction, userId: string) {
  const owner = await tx.user.findUnique({ where: { userId }, select: { phone: true } });
  return owner?.phone ?? null;
}
