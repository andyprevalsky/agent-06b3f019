/** Browser/user action -> durable command claim -> one physical operation -> encrypted receipt. */
import {
  PhoneHarnessClient,
  PhoneHarnessError,
  type PhoneHarnessSession,
} from '../../providers/phoneHarness';
import { openPhoneValue } from '../../providers/phoneHarnessCredentials';
import * as commands from './repo.operations';
import * as leases from './repo';
import { IPhoneError, type IPhoneOperation } from './types';
import type {
  CommandClaim,
  PhoneActor,
  PhoneClientFactory,
  PhoneCommand,
} from './types.operations';
import { cleanupPhone, ensurePhoneSession, PhoneConnectionPending } from './service.session';

export const defaultPhoneClient: PhoneClientFactory = () => new PhoneHarnessClient();

export function publicOperation(command: IPhoneOperation) {
  return {
    id: command.requestKey,
    cursor: command.cursor,
    operation: command.operation,
    status: command.state,
    errorCode: command.errorCode,
    result:
      command.resultEncrypted === null ? null : openPhoneValue<unknown>(command.resultEncrypted),
  };
}

function safeFailure(error: unknown, operation: string, started = false) {
  const unknown =
    !commands.isPhoneRead(operation) &&
    (error instanceof PhoneHarnessError ? error.outcome === 'unknown' : started);
  return {
    state: unknown ? ('UNKNOWN' as const) : ('FAILED' as const),
    value: {
      success: false,
      outcome: unknown ? 'unknown' : 'rejected',
      error: error instanceof PhoneHarnessError ? error.message : 'Phone command failed',
    },
    code: error instanceof PhoneHarnessError ? error.code : 'phone_command_failed',
  };
}

async function runClaim(claim: CommandClaim, input: PhoneCommand, client: PhoneHarnessClient) {
  let started = false;
  try {
    const session = await ensurePhoneSession(claim, client);
    if (!(await commands.beginExecution(claim))) return null;
    started = true;
    const result = await client.perform(session, input.operation, input.args);
    return await commands.finishCommand(claim, 'SUCCEEDED', result);
  } catch (error) {
    if (error instanceof PhoneConnectionPending) return null;
    const failure = safeFailure(error, input.operation, started);
    return commands.finishCommand(claim, failure.state, failure.value, failure.code);
  }
}

export async function performPhoneCommand(
  userId: string,
  leaseId: string,
  input: PhoneCommand,
  actor: PhoneActor,
  clientFactory: PhoneClientFactory = defaultPhoneClient
) {
  const claim = await commands.claimCommand(userId, leaseId, input, actor);
  let command = claim.command;
  if (claim.execute) {
    let client: PhoneHarnessClient;
    try {
      client = clientFactory();
    } catch (error) {
      const failure = safeFailure(error, input.operation);
      command = await commands.finishCommand(claim, 'FAILED', failure.value, failure.code);
      return { operation: publicOperation(command) };
    }
    command =
      (await runClaim(claim, input, client)) ??
      (await commands.ownedCommand(userId, leaseId, input.operationId)) ??
      command;
  }
  const phone = await cleanupPhoneIfConfigured(userId, clientFactory);
  return { operation: publicOperation(command), ...(phone === null ? {} : { phone }) };
}

export async function phoneOperationStatus(userId: string, leaseId: string, operationId: string) {
  const command = await commands.ownedCommand(userId, leaseId, operationId);
  if (command === null) throw new IPhoneError(404, 'Phone operation not found');
  return { operation: publicOperation(command) };
}

export async function cleanupPhoneIfConfigured(userId: string, clientFactory = defaultPhoneClient) {
  if (!(await commands.deviceExists(userId))) return null;
  return cleanupPhone(userId, clientFactory);
}

export async function phoneFrame(
  userId: string,
  leaseId: string,
  clientFactory: PhoneClientFactory = defaultPhoneClient
) {
  const device = await leases.transaction(async (tx) => {
    if ((await leases.readLease(tx, leaseId, userId)) === null)
      throw new IPhoneError(404, 'Lease not found');
    const owned = await leases.lockedDevice(tx, userId);
    const lease = await leases.readLease(tx, leaseId, userId);
    if (!owned.enabled) throw new IPhoneError(403, 'iPhone access denied');
    if (lease?.status !== 'ACTIVE') throw new IPhoneError(409, 'Phone interaction is not active');
    return owned.device;
  });
  if (device.providerState !== 'READY' || device.providerSessionEncrypted === null)
    throw new IPhoneError(409, 'Phone view is not ready');
  const session = openPhoneValue<PhoneHarnessSession>(device.providerSessionEncrypted);
  try {
    return await clientFactory().frame(session);
  } catch {
    throw new IPhoneError(503, 'Phone view is temporarily unavailable');
  }
}
