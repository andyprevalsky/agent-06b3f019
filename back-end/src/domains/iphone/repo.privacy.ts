/** Caller holds device lock; privacy admission precedes physical provider execution. */
import { prisma } from '../../providers/database';
import { IPhoneError, type IPhoneDevice, type Transaction } from './types';
import type { PhoneActor, PhoneCommand } from './types.operations';
import { isModelMedia, privacyState, rememberPrivate, resumedPrivacy } from './privacy';

export async function claimPrivacy(
  tx: Transaction,
  device: IPhoneDevice,
  input: PhoneCommand,
  actor: PhoneActor,
  observation: boolean,
  taskBound: boolean
) {
  if (!observation && isModelMedia(input.operation))
    return new IPhoneError(403, 'Phone model media is unavailable');
  if (
    privacyState(device.privateInputEncrypted).active &&
    ((observation && !taskBound) || (!observation && actor === 'agent'))
  )
    return new IPhoneError(409, 'Phone private input is active');
  if (actor === 'user' && input.operation === 'input.text') {
    const encrypted = rememberPrivate(device.privateInputEncrypted, input.args.s);
    await tx.iPhoneDevice.update({
      where: { id: device.id },
      data: { privateInputEncrypted: encrypted },
    });
    device.privateInputEncrypted = encrypted;
  }
  return null;
}
export async function resumePrivacy(tx: Transaction, deviceId: string) {
  const device = await tx.iPhoneDevice.findUniqueOrThrow({ where: { id: deviceId } });
  await tx.iPhoneDevice.update({
    where: { id: device.id },
    data: { privateInputEncrypted: resumedPrivacy(device.privateInputEncrypted) },
  });
}

/** Indexed current policy lookup for old receipts; never scan command history. */
export async function operationPrivacy(deviceId: string) {
  const device = await prisma.iPhoneDevice.findUniqueOrThrow({
    where: { id: deviceId },
    select: { privateInputEncrypted: true },
  });
  return device.privateInputEncrypted;
}
