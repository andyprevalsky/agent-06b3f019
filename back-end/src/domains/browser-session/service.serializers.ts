import { iphoneCapability } from '../../providers/phoneAccountPolicy';
import type { SerializedPasskey, SerializedPassword, UserSettings } from './types';

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

export function serializePasswords(
  passwords: Array<{
    id: string;
    origin: string;
    username: string;
    encryptedPassword: string;
    dateLastUsed: bigint | null;
  }>
): SerializedPassword[] {
  return passwords.map((p) => ({
    id: p.id,
    origin: p.origin,
    username: p.username,
    encryptedPassword: p.encryptedPassword,
    dateLastUsed: p.dateLastUsed !== null ? Number(p.dateLastUsed) : null,
  }));
}

export function toUserSettings(
  user: {
    userId: string;
    isAnonymous: boolean;
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
  } | null
): UserSettings | null {
  if (user === null) return null;
  return {
    ...iphoneCapability(user),
    name: user.name,
    email: user.email,
    phone: user.phone,
    deliveryRecipientName: user.deliveryRecipientName,
    addressLine1: user.addressLine1,
    addressLine2: user.addressLine2,
    city: user.city,
    state: user.state,
    postalCode: user.postalCode,
    country: user.country,
    encryptedPaymentInformation: user.encryptedPaymentInformation,
    systemName: user.systemName,
    profilePicture: user.profilePicture,
    customSystemPrompt: user.customSystemPrompt,
  };
}
