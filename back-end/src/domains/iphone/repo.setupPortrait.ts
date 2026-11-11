import { currentPortraitRoute } from './repo.portraitRoute';
import {
  lockNativePhoneDevice,
  validateNativePhoneLease,
} from '../../providers/nativePhoneAttentionBinding';
import { privacyState } from './privacy';
import type { SetupLocalPortraitResult } from '../../providers/phoneSetupVerifier';
/** Read-only fences around fresh internal portrait observation; never allocates a session. */
import { PORTRAIT_LAYOUT } from '../../providers/phonePortraitProof';
import {
  openPhoneValue,
  sealPhoneValue,
  phoneCommandHash,
} from '../../providers/phoneHarnessCredentials';
import { type PhoneHarnessSession } from '../../providers/phoneHarness';
import { setupState, type SetupInput } from '../../providers/phoneSetupState';
import { lockSetupCommit, setupCommitValid } from './repo.setupFence';
import type { SetupClaim } from './repo.setupCommand';
import * as leases from './repo';
import { IPhoneError, type Transaction } from './types';
export async function portraitSession(tx: Transaction, claim: SetupClaim, input: SetupInput) {
  const device = await lockSetupCommit(tx, claim);
  const command = await tx.iPhoneOperation.findUniqueOrThrow({ where: { id: claim.command.id } });
  const now = await leases.databaseNow(tx);
  if (
    input.action !== 'verify' ||
    input.verificationTarget !== 'portrait_lock' ||
    command.activeDeviceId !== device.id ||
    command.deadlineAt === null ||
    command.deadlineAt.getTime() <= now.getTime() ||
    device.providerState !== 'READY' ||
    device.providerSessionEncrypted === null ||
    !(await setupCommitValid(tx, device, claim, input, command, setupState(device.setupEncrypted)))
  )
    throw new IPhoneError(
      409,
      'Phone portrait observation changed',
      'phone_portrait_observation_changed'
    );
  const session = openPhoneValue<PhoneHarnessSession>(device.providerSessionEncrypted);
  if (
    session.id !== device.providerSessionId ||
    session.state !== 'ready' ||
    session.closeRequested ||
    session.cleanupComplete ||
    !session.control ||
    session.control.expiresAt === null ||
    !Number.isFinite(session.control.expiresAt) ||
    session.control.expiresAt * 1000 <= now.getTime() ||
    session.expiresAt === null ||
    !Number.isFinite(session.expiresAt) ||
    session.expiresAt * 1000 <= now.getTime()
  )
    throw new IPhoneError(
      409,
      'Phone portrait session is not ready',
      'phone_portrait_session_not_ready'
    );
  const route = await currentPortraitRoute(tx, claim, input, now);
  if (route === null)
    throw new IPhoneError(
      409,
      'Phone native portrait route is unproven',
      'phone_portrait_route_unproven'
    );
  return { session, route, deadlineAt: command.deadlineAt.getTime(), now: now.getTime() };
}
export const currentPortraitSession = (claim: SetupClaim, input: SetupInput) =>
  leases.transaction((tx) => portraitSession(tx, claim, input));

export async function recordPortraitProof(
  claim: SetupClaim,
  input: SetupInput,
  proof: SetupLocalPortraitResult['localPortrait']
) {
  return leases.transaction(async (tx) => {
    const current = await portraitSession(tx, claim, input);
    if (
      proof.routeDigest !== current.route.digest ||
      proof.originalAssistiveTouch !== current.route.originalAssistiveTouch
    )
      throw new IPhoneError(
        409,
        'Phone native portrait route changed',
        'phone_portrait_route_changed'
      );
    const command = await tx.iPhoneOperation.findUniqueOrThrow({ where: { id: claim.command.id } });
    const metadata = {
      ...proof,
      cursor: command.cursor,
      providerEpoch: command.providerEpoch,
      profileRevision: claim.state.profileRevision,
      firstRun: claim.state.attempt!.firstExecutionRunId,
      revisionAfter: input.expectedRevision + 1,
    };
    const evidenceDigest = phoneCommandHash('phone-portrait-local', metadata, 'agent');
    const request = openPhoneValue<Record<string, unknown>>(command.requestEncrypted);
    await tx.iPhoneOperation.update({
      where: { id: command.id },
      data: {
        requestEncrypted: sealPhoneValue({ ...request, evidenceDigest, portraitProof: metadata }),
      },
    });
    claim.evidenceDigest = evidenceDigest;
  });
}
export async function validPortraitCommit(
  tx: Transaction,
  claim: SetupClaim,
  input: SetupInput,
  command: SetupClaim['command'],
  proof: SetupLocalPortraitResult['localPortrait']
) {
  try {
    const context = await portraitSession(tx, claim, input);
    const captured = Date.parse(proof.capturedAt);
    if (
      proof.routeDigest !== context.route.digest ||
      proof.originalAssistiveTouch !== context.route.originalAssistiveTouch ||
      proof.layout !== PORTRAIT_LAYOUT ||
      !/^[a-f0-9]{64}$/.test(proof.digest) ||
      !Number.isFinite(captured) ||
      captured > context.now ||
      context.now - captured > 30000
    )
      return false;
    const request = openPhoneValue<Record<string, unknown>>(command.requestEncrypted);
    const metadata = {
      ...proof,
      cursor: command.cursor,
      providerEpoch: command.providerEpoch,
      profileRevision: claim.state.profileRevision,
      firstRun: claim.state.attempt!.firstExecutionRunId,
      revisionAfter: input.expectedRevision + 1,
    };
    const digest = phoneCommandHash('phone-portrait-local', metadata, 'agent');
    return (
      request.evidenceDigest === digest &&
      claim.evidenceDigest === digest &&
      phoneCommandHash('portrait-metadata', request.portraitProof, 'agent') ===
        phoneCommandHash('portrait-metadata', metadata, 'agent')
    );
  } catch {
    return false;
  }
}

/** An ephemeral current-layout OFF hint; never stored as reusable command data. */
export async function currentPortraitHint(command: SetupClaim['command']) {
  if (
    command.operation !== 'setup.verify' ||
    command.actor !== 'agent' ||
    command.state !== 'SUCCEEDED'
  )
    return null;
  try {
    return await leases.transaction(async (tx) => {
      let lease = await tx.iPhoneLease.findUniqueOrThrow({ where: { id: command.leaseId } });
      if (lease.browserTaskId === null || lease.browserTaskId.length === 0) return null;
      const device = await lockNativePhoneDevice(tx, lease.userId, lease.agentId);
      const current = await validateNativePhoneLease(
        tx,
        lease.userId,
        lease.agentId,
        { kind: 'iphone', browserTaskId: lease.browserTaskId, leaseId: lease.id },
        device.id
      );
      const agent = current.agent;
      lease = current.lease;
      const state = setupState(device.setupEncrypted);
      const request = openPhoneValue<{
        input: SetupInput;
        workflowId: string;
        portraitProof?: SetupLocalPortraitResult['localPortrait'] & {
          profileRevision: number;
          firstRun?: string;
          revisionAfter: number;
        };
      }>(command.requestEncrypted);
      const proof = request.portraitProof;
      const now = await leases.databaseNow(tx);
      if (
        !proof ||
        command.deadlineAt === null ||
        command.deadlineAt.getTime() <= now.getTime() ||
        proof.status !== 'disabled' ||
        !/^[a-f0-9]{64}$/.test(proof.routeDigest) ||
        !['on', 'off'].includes(proof.originalAssistiveTouch) ||
        proof.layout !== PORTRAIT_LAYOUT ||
        command.providerEpoch !== device.providerEpoch ||
        device.providerState !== 'READY' ||
        lease.actionCursor !== command.cursor ||
        lease.controlOwner !== 'agent' ||
        lease.attentionRequestId !== null ||
        privacyState(device.privateInputEncrypted).active ||
        state.profileRevision !== proof.profileRevision ||
        state.claimRevision !== proof.revisionAfter ||
        state.attempt?.id !== request.input.attemptId ||
        state.attempt.workflowId !== request.workflowId ||
        (agent.temporalWorkflowId ?? agent.id) !== request.workflowId ||
        agent.temporalFirstExecutionRunId !== proof.firstRun ||
        state.expectedPhone !==
          (await tx.user.findUniqueOrThrow({ where: { userId: lease.userId } })).phone ||
        !Number.isFinite(Date.parse(proof.capturedAt)) ||
        now.getTime() < Date.parse(proof.capturedAt) ||
        now.getTime() - Date.parse(proof.capturedAt) > 30000
      )
        return null;
      return { operation: 'input.tap', args: { x: 150, y: 529 }, evidenceCursor: command.cursor };
    });
  } catch {
    return null;
  }
}
