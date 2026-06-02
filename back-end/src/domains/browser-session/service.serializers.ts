import type { SerializedPassword, UserSettings } from './types';

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
    name: string | null;
    phone: string | null;
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
    name: user.name,
    phone: user.phone,
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
