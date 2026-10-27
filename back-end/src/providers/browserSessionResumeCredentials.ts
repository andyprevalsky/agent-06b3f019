/**
 * Credential and settings reads behind the browser-session resume response:
 * saved passwords, realm passkeys (with a reserved sign-count block) and the
 * user's settings, serialized the way the worker consumes them.
 */
import { prisma } from './database';
import { iphoneCapability } from './phoneAccountPolicy';

export interface SerializedPassword {
  id: string;
  origin: string;
  username: string;
  encryptedPassword: string;
  dateLastUsed: number | null;
}

export interface UserSettings {
  iphoneCapability?: { enabled: true };
  name: string | null;
  email: string | null;
  phone: string | null;
  deliveryRecipientName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  encryptedPaymentInformation: string | null;
  systemName: string | null;
  profilePicture: string | null;
  customSystemPrompt: string | null;
}

export interface SerializedPasskey {
  id: string;
  credentialId: string;
  encryptedPrivateKey: string;
  rpId: string;
  userHandle: string | null;
  signCount: number;
}

export function serializePasswords(
  passwords: Array<{
    id: string;
    origin: string;
    username: string;
    encryptedPassword: string;
    dateLastUsed: bigint | null;
  }>
): SerializedPassword[] {
  return passwords.map((password) => ({
    id: password.id,
    origin: password.origin,
    username: password.username,
    encryptedPassword: password.encryptedPassword,
    dateLastUsed: password.dateLastUsed !== null ? Number(password.dateLastUsed) : null,
  }));
}

export function serializePasskeys(
  passkeys: Array<{
    id: string;
    credentialId: string;
    encryptedPrivateKey: string;
    rpId: string;
    userHandle: string | null;
    signCount: number;
  }>
): SerializedPasskey[] {
  return passkeys.map((p) => ({
    id: p.id,
    credentialId: p.credentialId,
    encryptedPrivateKey: p.encryptedPrivateKey,
    rpId: p.rpId,
    userHandle: p.userHandle,
    signCount: p.signCount,
  }));
}

type SettingsAccount = UserSettings & { userId: string; isAnonymous: boolean };
export function toUserSettings(user: SettingsAccount | null): UserSettings | null {
  if (user === null) return null;
  const { userId, isAnonymous, ...settings } = user;
  return { ...settings, ...iphoneCapability({ userId, isAnonymous, phone: user.phone }) };
}

export async function findUserSettings(userId: string): Promise<SettingsAccount | null> {
  return prisma.user.findUnique({
    where: { userId },
    select: {
      userId: true,
      isAnonymous: true,
      name: true,
      email: true,
      phone: true,
      deliveryRecipientName: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
      encryptedPaymentInformation: true,
      systemName: true,
      profilePicture: true,
      customSystemPrompt: true,
    },
  });
}

export async function findPasswords(userId: string) {
  return prisma.browserPassword.findMany({
    where: { userId, disabledAt: null },
    select: {
      id: true,
      origin: true,
      username: true,
      encryptedPassword: true,
      dateLastUsed: true,
    },
    orderBy: { dateLastUsed: 'desc' },
  });
}

const PASSKEY_SIGNCOUNT_RESERVE_BLOCK = 100n;

export async function reservePasskeysForRealm(userId: string, authRealm: string) {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      credentialId: string;
      encryptedPrivateKey: string;
      rpId: string;
      userHandle: string | null;
      base: bigint;
    }>
  >`
    UPDATE "PasskeyCredential"
    SET "signCount" = "signCount" + ${PASSKEY_SIGNCOUNT_RESERVE_BLOCK}
    WHERE "userId" = ${userId}
      AND "authRealm" = ${authRealm}
      AND "disabledAt" IS NULL
    RETURNING id, "credentialId", "encryptedPrivateKey", "rpId", "userHandle",
              ("signCount" - ${PASSKEY_SIGNCOUNT_RESERVE_BLOCK}) AS base
  `;
  return rows.map((r) => ({
    id: r.id,
    credentialId: r.credentialId,
    encryptedPrivateKey: r.encryptedPrivateKey,
    rpId: r.rpId,
    userHandle: r.userHandle,
    signCount: Number(r.base),
  }));
}
