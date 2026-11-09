/** Persistent device grants; creation and cleanup are recovered with the same durable key. */
import {
  PhoneHarnessError,
  type PhoneHarnessClient,
  type PhoneHarnessSession,
} from '../../providers/phoneHarness';
import { retryWithBackoff } from '../../providers/retry';
import { openPhoneValue } from '../../providers/phoneHarnessCredentials';
import type { IPhoneDevice } from './types';
import * as commands from './repo.operations';
import type { CommandClaim, PhoneClientFactory } from './types.operations';

export class PhoneConnectionPending extends Error {
  constructor(public readonly code: string) {
    super('Phone connection is still being prepared');
  }
}

export function isFresh(session: PhoneHarnessSession): boolean {
  return (
    session.state === 'ready' &&
    !session.closeRequested &&
    !session.cleanupComplete &&
    session.control !== null &&
    session.control.expiresAt !== null &&
    session.control.expiresAt * 1000 > Date.now() + 10_000 &&
    session.expiresAt !== null &&
    session.expiresAt * 1000 > Date.now() + 10_000
  );
}

async function receiptOrMissing(client: PhoneHarnessClient, key: string) {
  try {
    return await client.recover(key);
  } catch (error) {
    if (error instanceof PhoneHarnessError && error.status === 404) return null;
    throw error;
  }
}

async function stopAndConfirm(device: IPhoneDevice, client: PhoneHarnessClient): Promise<boolean> {
  const key = device.providerStartKey;
  if (key === null) return true;
  let sessionId = device.providerSessionId;
  if (sessionId === null) {
    const receipt = await receiptOrMissing(client, key);
    if (receipt?.cleanupComplete === true) return true;
    sessionId = receipt?.session?.id ?? null;
  }
  // Missing receipts leave the same request quarantined; they do not authorize a new start key.
  if (sessionId === null) return false;
  await client.stop(sessionId);
  const receipt = await receiptOrMissing(client, key);
  return receipt?.cleanupComplete === true;
}

export async function cleanupPhone(userId: string, clientFactory: PhoneClientFactory) {
  const candidate = await commands.cleanupCandidate(userId);
  if (candidate === null) return null;
  try {
    const complete = await stopAndConfirm(candidate.device, clientFactory());
    if (!complete) return { state: 'cleanup_pending' };
    const key = candidate.device.providerStartKey;
    if (key !== null) {
      const retained =
        candidate.operation?.state === 'CONNECTING' &&
        candidate.lease?.status === 'ACTIVE' &&
        candidate.lease.releaseRequestedAt === null
          ? candidate.operation.id
          : undefined;
      await commands.confirmCleanup(candidate.device.id, key, retained);
    } else if (candidate.operation !== null)
      await commands.confirmUnstartedCleanup(candidate.device.id, candidate.operation.id);
    return { state: 'cleanup_complete' };
  } catch (error) {
    return {
      state: 'cleanup_pending',
      error:
        error instanceof PhoneHarnessError ? error.message : 'Phone cleanup could not be confirmed',
    };
  }
}

export async function ensurePhoneSession(claim: CommandClaim, client: PhoneHarnessClient) {
  let device = await commands.reserveSession(claim.device.id);
  if (device.providerState === 'CLOSING') throw new PhoneConnectionPending('cleanup_pending');
  let session =
    device.providerSessionEncrypted === null
      ? null
      : openPhoneValue<PhoneHarnessSession>(device.providerSessionEncrypted);
  if (session !== null && isFresh(session)) return session;
  const key = device.providerStartKey!;
  const receipt = await receiptOrMissing(client, key);
  if (
    receipt?.cleanupComplete === true ||
    (session !== null &&
      session.expiresAt !== null &&
      session.expiresAt * 1000 <= Date.now() + 10_000)
  ) {
    await commands.closeSessionForRefresh(device.id, key);
    if (!(receipt?.cleanupComplete === true || (await stopAndConfirm(device, client))))
      throw new PhoneConnectionPending('cleanup_pending');
    await commands.confirmCleanup(device.id, key, claim.command.id);
    device = await commands.reserveSession(device.id);
    session = null;
  } else if (receipt?.session !== null && receipt?.session !== undefined) {
    session = receipt.session;
  }
  if (session === null) {
    try {
      session = await client.create(device.providerDeviceId, device.providerStartKey!);
    } catch (error) {
      if (!(error instanceof PhoneHarnessError) || error.outcome !== 'unknown') throw error;
      const recovered = await receiptOrMissing(client, device.providerStartKey!);
      if (recovered?.session === null || recovered?.session === undefined)
        throw new PhoneConnectionPending('start_outcome_unknown');
      session = recovered.session;
    }
  }
  const until = Date.now() + 10_000;
  if (session.state === 'provisioning') {
    const sessionId = session.id;
    session = await retryWithBackoff(() => client.get(sessionId), {
      maxRetries: 40,
      fixedDelays: Array<number>(39).fill(250),
      isRetryable: () => false,
      shouldRetryResult: (observed) => observed.state === 'provisioning' && Date.now() < until,
      component: 'IPhoneReady',
    });
  }
  if (!(await commands.saveSession(device.id, device.providerStartKey!, session)))
    throw new PhoneConnectionPending('cleanup_pending');
  if (session.state === 'provisioning') throw new PhoneConnectionPending('starting');
  if (!isFresh(session))
    throw new PhoneHarnessError(
      'Phone session is not ready',
      null,
      'session_unavailable',
      'rejected'
    );
  return session;
}
