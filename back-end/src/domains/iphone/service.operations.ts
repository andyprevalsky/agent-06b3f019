import { assessAuthLoss } from './service.authLoss';
import type { ImessageAuthLossVerifier } from '../../providers/phoneAuthLoss';
import { currentPortraitHint } from './repo.setupPortrait';
import { runDevicePasscode } from './service.passcode';
import { runMessage } from './service.message';
import type { MessageVerifier } from '../../providers/phoneMessageVerifier';
import { runSavedCredential } from './service.savedCredential';
import type { CredentialVerifier } from '../../providers/phoneCredentialVerifier';
/** Browser/user action -> durable command claim -> one physical operation -> encrypted receipt. */
import { PhoneHarnessClient, PhoneHarnessError } from '../../providers/phoneHarness';
import { operationPrivacy } from './repo.privacy';
import { privateResult } from './privacy';
import { openPhoneValue } from '../../providers/phoneHarnessCredentials';
import * as commands from './repo.operations';
import { IPhoneError, type IPhoneOperation } from './types';
import type {
  CommandClaim,
  PhoneActor,
  PhoneClientFactory,
  PhoneCommand,
} from './types.operations';
import { cleanupPhone, ensurePhoneSession, PhoneConnectionPending } from './service.session';

export const defaultPhoneClient: PhoneClientFactory = () => new PhoneHarnessClient();

export async function publicOperation(command: IPhoneOperation) {
  const encryptedPrivacy = await operationPrivacy(command.deviceId);
  const portraitActionHint = await currentPortraitHint(command);
  return {
    id: command.requestKey,
    cursor: command.cursor,
    operation: command.operation,
    status: command.state,
    errorCode: command.errorCode,
    ...(portraitActionHint ? { portraitActionHint } : {}),
    result:
      command.resultEncrypted === null
        ? null
        : privateResult(
            command,
            openPhoneValue<unknown>(command.resultEncrypted),
            encryptedPrivacy
          ),
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

async function runClaim(
  claim: CommandClaim,
  input: PhoneCommand,
  client: PhoneHarnessClient,
  authLossVerifier?: ImessageAuthLossVerifier
) {
  let started = false;
  try {
    const session = await ensurePhoneSession(claim, client);
    if (!(await commands.beginExecution(claim))) return null;
    started = true;
    const result = await client.perform(session, input.operation, input.args);
    await assessAuthLoss(claim, result, authLossVerifier);
    return await commands.finishCommand(claim, 'SUCCEEDED', result);
  } catch (error) {
    if (error instanceof PhoneConnectionPending && !started)
      return commands.finishCommand(
        claim,
        'FAILED',
        {
          success: false,
          outcome: 'rejected',
          error: error.message,
        },
        'phone_connection_not_ready'
      );
    const failure = safeFailure(error, input.operation, started);
    return commands.finishCommand(claim, failure.state, failure.value, failure.code);
  }
}

export async function performPhoneCommand(
  userId: string,
  leaseId: string,
  input: PhoneCommand,
  actor: PhoneActor,
  clientFactory: PhoneClientFactory = defaultPhoneClient,
  credentialVerifier?: CredentialVerifier,
  beforeSavedExecute?: () => Promise<void>,
  messageVerifier?: MessageVerifier,
  authLossVerifier?: ImessageAuthLossVerifier
) {
  if (
    ['credentials.fill_saved', 'credentials.fill_device_passcode'].includes(input.operation) &&
    (actor !== 'agent' ||
      Object.keys(input.args).length !== 0 ||
      input.expectedCursor === undefined ||
      input.setupAttemptId === undefined ||
      input.setupRevision === undefined)
  )
    throw new IPhoneError(
      400,
      'Saved credential operation requires empty args and current setup context'
    );
  const message =
    input.operation === 'messages.send_approved' || input.operation === 'messages.verify_sent';
  if (
    message &&
    (actor !== 'agent' ||
      Object.keys(input.args).length !== 1 ||
      typeof input.args.queueId !== 'string' ||
      input.expectedCursor === undefined ||
      input.setupAttemptId === undefined ||
      input.setupRevision === undefined)
  )
    throw new IPhoneError(400, 'Message operation requires queueId and current setup context');
  const claim = await commands.claimCommand(userId, leaseId, input, actor);
  let command = claim.command;
  if (claim.execute) {
    let client: PhoneHarnessClient;
    try {
      client = clientFactory();
    } catch (error) {
      const failure = safeFailure(error, input.operation);
      command = await commands.finishCommand(claim, 'FAILED', failure.value, failure.code);
      return { operation: await publicOperation(command) };
    }
    command =
      (await (message
        ? runMessage(claim, input.args.queueId as string, client, messageVerifier)
        : input.operation === 'credentials.fill_device_passcode'
          ? runDevicePasscode(claim, client, credentialVerifier, beforeSavedExecute)
          : input.operation === 'credentials.fill_saved'
            ? runSavedCredential(claim, client, credentialVerifier, beforeSavedExecute)
            : runClaim(claim, input, client, authLossVerifier))) ??
      (await commands.ownedCommand(userId, leaseId, input.operationId)) ??
      command;
  }
  const phone = await cleanupPhoneIfConfigured(userId, clientFactory);
  return { operation: await publicOperation(command), ...(phone === null ? {} : { phone }) };
}

export async function phoneOperationStatus(userId: string, leaseId: string, operationId: string) {
  const command = await commands.ownedCommand(userId, leaseId, operationId);
  if (command === null) throw new IPhoneError(404, 'Phone operation not found');
  return { operation: await publicOperation(command) };
}

export async function cleanupPhoneIfConfigured(userId: string, clientFactory = defaultPhoneClient) {
  if (!(await commands.deviceExists(userId))) return null;
  return cleanupPhone(userId, clientFactory);
}

export { phoneFrame } from './service.view';
