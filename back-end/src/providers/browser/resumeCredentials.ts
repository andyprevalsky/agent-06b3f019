/** Resume credential wire types and lossless serialization. */
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
