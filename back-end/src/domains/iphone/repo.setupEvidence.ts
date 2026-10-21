import { requiresGoogleIdentity } from '../../providers/phoneSetupVerification';
import { openPhoneValue, phoneCommandHash } from '../../providers/phoneHarnessCredentials';
import { internalPhoneObservation } from './privacy';
import { IPhoneError, type Transaction, type IPhoneDevice, type IPhoneLease } from './types';
import type { SetupState, SetupInput } from '../../providers/phoneSetupState';
import type { SetupEvidence } from '../../providers/phoneSetupVerifier';
import { databaseNow } from './repo.clock';

export async function setupEvidence(
  tx: Transaction,
  device: IPhoneDevice,
  lease: IPhoneLease,
  state: SetupState,
  input: SetupInput
) {
  const evidence: SetupEvidence[] = [];
  const now = await databaseNow(tx);
  for (const id of input.evidenceOperationIds ?? []) {
    const row = await tx.iPhoneOperation.findUnique({
      where: { leaseId_requestKey: { leaseId: lease.id, requestKey: id } },
    });
    if (
      !row ||
      row.deviceId !== device.id ||
      row.actor !== 'agent' ||
      row.operation !== 'screen.text' ||
      row.state !== 'SUCCEEDED' ||
      row.providerEpoch !== device.providerEpoch ||
      row.cursor <= state.attempt!.floorCursor ||
      row.completedAt === null ||
      row.completedAt.getTime() < new Date(state.attempt!.floorAt).getTime() ||
      now.getTime() - row.completedAt.getTime() > 120_000 ||
      row.resultEncrypted === null
    )
      throw new IPhoneError(409, 'Setup observation is not current');
    const intent = openPhoneValue<{ setupAttemptId?: string; setupRevision?: number }>(
      row.requestEncrypted
    );
    if (
      intent.setupAttemptId !== input.attemptId ||
      intent.setupRevision !== input.expectedRevision
    )
      throw new IPhoneError(409, 'Setup observation belongs to another attempt');
    evidence.push({
      operationId: id,
      cursor: row.cursor,
      result: internalPhoneObservation(
        row,
        openPhoneValue(row.resultEncrypted),
        device.privateInputEncrypted,
        {
          expectedAppleIdentity: state.expectedAppleIdentity,
          ...(requiresGoogleIdentity(input.verificationTarget)
            ? { expectedGoogleIdentity: state.expectedGoogleIdentity }
            : {}),
        }
      ),
    });
  }
  evidence.sort((a, b) => a.cursor - b.cursor);
  if (
    evidence.length === 0 ||
    evidence[evidence.length - 1].cursor !== lease.actionCursor ||
    evidence.some((row, index) => row.cursor !== lease.actionCursor - evidence.length + index + 1)
  )
    throw new IPhoneError(
      409,
      'Setup observations must be the current uninterrupted cursor window'
    );
  if (Buffer.byteLength(JSON.stringify(evidence)) > 32768)
    throw new IPhoneError(400, 'Setup observations exceed verification bound');
  return { evidence, digest: phoneCommandHash('setup-evidence', evidence, 'agent') };
}

export async function assertSetupPhysicalKnown(tx: Transaction, deviceId: string) {
  if (
    (await tx.iPhoneOperation.findFirst({
      where: {
        deviceId,
        state: 'UNKNOWN',
        OR: [{ errorCode: null }, { errorCode: { not: 'provider_session_ended' } }],
      },
      select: { id: true },
    })) !== null
  )
    throw new IPhoneError(409, 'Phone physical outcome is unconfirmed');
}
