import { availabilityInTransaction } from './repo.availability';
import { createCommandJournal } from './repo.commandJournal';
/** Per-device command slot. Provider calls happen only after this transaction commits. */
import { executionCustody, rejectExecutionCustody } from './repo.executionCustody';
import { setupGate } from './repo.setupGate';
import { sealPhoneValue } from '../../providers/phoneHarnessCredentials';
import * as leases from './repo';
import { validateAttentionInput, taskBoundError, phoneIntent } from './repo.attention';
import { setupState } from '../../providers/phoneSetupState';
import { privateResult, internalPhoneObservation } from './privacy';
import { claimPrivacy } from './repo.privacy';
import { LEASE_TIMEOUT_MS } from './config';
import { IPhoneError, type Transaction, type IPhoneOperation } from './types';
import type { CommandClaim, PhoneActor, PhoneCommand } from './types.operations';

export const READ_OPERATIONS = new Set([
  'messages.verify_sent',
  'screen.frame',
  'screen.text',
  'screen.text_pixels',
  'screen.bounds',
  'session.state',
  'apps.current',
  'apps.list',
  'tree',
]);
export function isPhoneRead(operation: string): boolean {
  return READ_OPERATIONS.has(operation);
}

function replayableRejection(command: IPhoneOperation | null, inputHash: string) {
  // Failed rejection receipts contain no successful observation or new grant.
  return (
    command?.state === 'FAILED' &&
    command.inputHash === inputHash &&
    (command.errorCode === 'phone_setup_stale' ||
      (command.operation === 'credentials.fill_saved' &&
        command.errorCode === 'phone_credential_binding_required'))
  );
}

async function previousRejection(
  tx: Transaction,
  leaseId: string,
  input: PhoneCommand,
  actor: PhoneActor
) {
  const { inputHash } = phoneIntent(input, actor);
  const command = await tx.iPhoneOperation.findUnique({
    where: { leaseId_requestKey: { leaseId, requestKey: input.operationId } },
  });
  return command && replayableRejection(command, inputHash) ? command : null;
}

async function rawLock(tx: Transaction, deviceId: string) {
  await tx.$queryRaw`SELECT id FROM "IPhoneDevice" WHERE id = ${deviceId} FOR UPDATE`;
}

export async function claimCommand(
  userId: string,
  leaseId: string,
  input: PhoneCommand,
  actor: PhoneActor,
  observation = false,
  taskBound = false
): Promise<CommandClaim> {
  const result = await leases.transaction(async (tx) => {
    if ((await leases.readLease(tx, leaseId, userId)) === null)
      return new IPhoneError(404, 'Lease not found');
    const { device, enabled } = await leases.lockedDevice(tx, userId);
    if (!enabled) return new IPhoneError(403, 'iPhone access denied');
    const lease = await leases.readLease(tx, leaseId, userId);
    if (lease === null || lease.status !== 'ACTIVE' || lease.releaseRequestedAt !== null)
      return new IPhoneError(409, 'The phone is not reserved for this interaction');
    const taskError = await taskBoundError(tx, lease, taskBound);
    if (taskError !== null) return taskError;
    if (observation) actor = lease.controlOwner === 'user' ? 'user' : 'agent';
    if (lease.controlOwner !== actor)
      return new IPhoneError(409, 'Phone control belongs to the other participant');
    if (actor === 'agent' && lease.browserTaskId !== null) {
      const allowed = await availabilityInTransaction(tx, userId, lease.browserTaskId);
      if (!allowed.enabled) {
        const rejected = await previousRejection(tx, leaseId, input, actor);
        // An exact terminal rejection is not permission to observe or execute.
        // Never replay a successful result or accept changed input after revocation.
        if (rejected) return { device, lease, command: rejected, execute: false };
        return new IPhoneError(409, 'iPhone setup is required');
      }
    }
    if (!observation) {
      const error = await validateAttentionInput(tx, lease, input, actor);
      if (error !== null) return error;
    }
    const { inputHash, requestEncrypted } = phoneIntent(input, actor);
    const existing = await tx.iPhoneOperation.findUnique({
      where: { leaseId_requestKey: { leaseId, requestKey: input.operationId } },
    });
    if (existing !== null) {
      if (existing.inputHash !== inputHash)
        return new IPhoneError(409, 'Operation identity cannot be reused with different input');
      return { device, lease, command: existing, execute: false };
    }
    if (await messageMutationBlocked(tx, userId, lease.browserTaskId, input.operation))
      return new IPhoneError(409, 'A dispatched message permits observation and verification only');
    if (input.expectedCursor !== undefined && input.expectedCursor !== lease.actionCursor)
      return new IPhoneError(
        409,
        'Phone state changed; read the current interaction before acting'
      );
    const active = await tx.iPhoneOperation.findUnique({ where: { activeDeviceId: device.id } });
    if (active !== null && !isPhoneRead(input.operation))
      return new IPhoneError(409, 'A previous phone command is still running or unconfirmed');
    const inFlight = await tx.iPhoneOperation.findFirst({
      where: { deviceId: device.id, state: { in: ['CONNECTING', 'RUNNING'] } },
      select: { id: true },
    });
    if (inFlight !== null) return new IPhoneError(409, 'A phone request is still running');
    const privacyError = await claimPrivacy(tx, device, input, actor, observation, taskBound);
    if (privacyError !== null) return privacyError;
    const gated = observation
      ? null
      : await setupGate(tx, device.id, lease, input, actor, inputHash, requestEncrypted);
    if (gated !== null) return { device, lease, command: gated, execute: false };
    return createCommandJournal(tx, {
      device,
      lease,
      input,
      actor,
      inputHash,
      requestEncrypted,
      observation,
      taskBound,
      ownsSlot: active === null,
    });
  });
  if (result instanceof IPhoneError) throw result;
  return result;
}

/** Exactly one request may cross from connection recovery into physical execution. */
export async function beginExecution(claim: CommandClaim): Promise<boolean> {
  return leases.transaction(async (tx) => {
    const { device, enabled } = await leases.lockedDevice(tx, claim.lease.userId);
    const lease = await tx.iPhoneLease.findUnique({ where: { id: claim.lease.id } });
    if (
      claim.command.actor === 'agent' &&
      lease?.browserTaskId !== undefined &&
      lease.browserTaskId !== null
    ) {
      const allowed = await availabilityInTransaction(tx, claim.lease.userId, lease.browserTaskId);
      if (!allowed.enabled) {
        await rejectExecutionCustody(tx, claim);
        return false;
      }
    }
    if (
      lease === null ||
      lease.status !== 'ACTIVE' ||
      lease.releaseRequestedAt !== null ||
      lease.controlOwner !== claim.command.actor ||
      device.providerState === 'CLOSING' ||
      !enabled
    )
      return false;
    if (!(await executionCustody(tx, claim, device, lease))) return false;
    const changed = await tx.iPhoneOperation.updateMany({
      where: {
        id: claim.command.id,
        state: 'CONNECTING',
        deadlineAt: { gt: await leases.databaseNow(tx) },
      },
      data: { state: 'RUNNING' },
    });
    return changed.count === 1;
  });
}

export async function finishCommand(
  claim: CommandClaim,
  state: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN',
  value: unknown,
  errorCode?: string
) {
  return leases.transaction(async (tx) => {
    await rawLock(tx, claim.device.id);
    const device = await tx.iPhoneDevice.findUniqueOrThrow({ where: { id: claim.device.id } });
    const resultEncrypted = sealPhoneValue(
      claim.command.operation === 'screen.text' &&
        claim.command.actor === 'agent' &&
        state === 'SUCCEEDED'
        ? internalPhoneObservation(
            { ...claim.command, state },
            value,
            device.privateInputEncrypted,
            setupState(device.setupEncrypted)
          )
        : privateResult({ ...claim.command, state }, value, device.privateInputEncrypted)
    );
    const now = await leases.databaseNow(tx);
    await tx.iPhoneOperation.updateMany({
      where: { id: claim.command.id, state: { in: ['CONNECTING', 'RUNNING'] } },
      data: {
        state,
        resultEncrypted,
        errorCode,
        completedAt: now,
        ...(state !== 'UNKNOWN' ? { activeDeviceId: null } : {}),
      },
    });
    await tx.iPhoneLease.updateMany({
      where: { id: claim.lease.id, status: 'ACTIVE' },
      data: { leaseExpiresAt: new Date(now.getTime() + LEASE_TIMEOUT_MS) },
    });
    return tx.iPhoneOperation.findUniqueOrThrow({ where: { id: claim.command.id } });
  });
}

export async function ownedCommand(userId: string, leaseId: string, operationId: string) {
  return leases.transaction(async (tx) => {
    if ((await leases.readLease(tx, leaseId, userId)) === null)
      throw new IPhoneError(404, 'Lease not found');
    await leases.lockedDevice(tx, userId);
    return tx.iPhoneOperation.findUnique({
      where: { leaseId_requestKey: { leaseId, requestKey: operationId } },
    });
  });
}

export async function cleanupCandidate(userId: string) {
  return leases.transaction(async (tx) => {
    const { device } = await leases.lockedDevice(tx, userId);
    const operation = await tx.iPhoneOperation.findUnique({ where: { activeDeviceId: device.id } });
    if (operation === null) {
      // A completed command releases its slot, not the persistent session.
      // Under the same device lock, keep a valid owner (including a FIFO
      // successor) and any outstanding read RPC; otherwise fence admission
      // before crossing the provider cleanup boundary.
      if (device.providerStartKey === null) return null;
      const owner = await tx.iPhoneLease.findFirst({
        where: { deviceId: device.id, status: 'ACTIVE' },
        select: { id: true },
      });
      const inFlight = await tx.iPhoneOperation.findFirst({
        where: { deviceId: device.id, state: { in: ['CONNECTING', 'RUNNING'] } },
        select: { id: true },
      });
      if ((owner !== null && device.providerState !== 'CLOSING') || inFlight !== null) return null;
      await tx.iPhoneDevice.update({
        where: { id: device.id },
        data: { providerState: 'CLOSING' },
      });
      return { device, operation: null, lease: null };
    }
    const lease = await tx.iPhoneLease.findUnique({ where: { id: operation.leaseId } });
    const now = await leases.databaseNow(tx);
    if (
      device.providerState !== 'CLOSING' &&
      lease?.releaseRequestedAt === null &&
      operation.deadlineAt > now
    )
      return null;
    await tx.iPhoneDevice.update({ where: { id: device.id }, data: { providerState: 'CLOSING' } });
    return { device, operation, lease };
  });
}

export async function deviceExists(userId: string) {
  return leases.transaction((tx) =>
    tx.iPhoneDevice.findUnique({
      where: { userId },
      select: { id: true },
    })
  );
}

export {
  reserveSession,
  saveSession,
  confirmCleanup,
  confirmUnstartedCleanup,
  closeSessionForRefresh,
} from './repo.session';

async function messageMutationBlocked(
  tx: Transaction,
  userId: string,
  taskId: string | null,
  operation: string
) {
  if (taskId === null || isPhoneRead(operation)) return false;
  return (
    (await tx.imessageQueue.findFirst({
      where: {
        userId,
        phoneBrowserTaskId: taskId,
        transport: 'phone_harness',
        dispatchedAt: { not: null },
        sentAt: null,
        failedAt: null,
      },
      select: { id: true },
    })) !== null
  );
}
