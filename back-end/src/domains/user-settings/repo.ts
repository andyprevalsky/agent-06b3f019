/**
 * User-settings domain repo — all Prisma calls for user settings.
 */

import { prisma } from '../../providers/database';
import type { UpdateUserBody } from './types';

/** Find a user by userId. Returns null if not found. */
export async function findUser(userId: string) {
  return prisma.user.findUnique({
    where: { userId },
  });
}

/** Upsert user settings (full replace). */
export async function upsertUser(userId: string, data: UpdateUserBody) {
  return prisma.user.upsert({
    where: { userId },
    update: {
      name: data.name,
      addressLine1: data.addressLine1,
      addressLine2: data.addressLine2,
      city: data.city,
      state: data.state,
      postalCode: data.postalCode,
      country: data.country,
      encryptedPaymentInformation: data.encryptedPaymentInformation,
      systemName: data.systemName,
      profilePicture: data.profilePicture,
      customSystemPrompt: data.customSystemPrompt,
      voicePreferenceId: data.voicePreferenceId,
    },
    create: {
      userId,
      name: data.name,
      addressLine1: data.addressLine1,
      addressLine2: data.addressLine2,
      city: data.city,
      state: data.state,
      postalCode: data.postalCode,
      country: data.country,
      encryptedPaymentInformation: data.encryptedPaymentInformation,
      systemName: data.systemName,
      profilePicture: data.profilePicture,
      customSystemPrompt: data.customSystemPrompt,
      voicePreferenceId: data.voicePreferenceId,
    },
  });
}

/** Create a new user record. */
export async function createUser(userId: string, data: UpdateUserBody) {
  return prisma.user.create({
    data: {
      userId,
      name: data.name,
      addressLine1: data.addressLine1,
      addressLine2: data.addressLine2,
      city: data.city,
      state: data.state,
      postalCode: data.postalCode,
      country: data.country,
      encryptedPaymentInformation: data.encryptedPaymentInformation,
      systemName: data.systemName,
      profilePicture: data.profilePicture,
      customSystemPrompt: data.customSystemPrompt,
      voicePreferenceId: data.voicePreferenceId,
    },
  });
}

/** Partially update an existing user record (only provided fields). */
export async function partialUpdateUser(userId: string, data: UpdateUserBody) {
  const updateData: Record<string, unknown> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.addressLine1 !== undefined) updateData.addressLine1 = data.addressLine1;
  if (data.addressLine2 !== undefined) updateData.addressLine2 = data.addressLine2;
  if (data.city !== undefined) updateData.city = data.city;
  if (data.state !== undefined) updateData.state = data.state;
  if (data.postalCode !== undefined) updateData.postalCode = data.postalCode;
  if (data.country !== undefined) updateData.country = data.country;
  if (data.encryptedPaymentInformation !== undefined)
    updateData.encryptedPaymentInformation = data.encryptedPaymentInformation;
  if (data.systemName !== undefined) updateData.systemName = data.systemName;
  if (data.profilePicture !== undefined) updateData.profilePicture = data.profilePicture;
  if (data.customSystemPrompt !== undefined)
    updateData.customSystemPrompt = data.customSystemPrompt;
  if (data.voicePreferenceId !== undefined)
    updateData.voicePreferenceId = data.voicePreferenceId;

  if (Object.keys(updateData).length === 0) {
    return prisma.user.findUniqueOrThrow({ where: { userId } });
  }

  return prisma.user.update({
    where: { userId },
    data: updateData,
  });
}
