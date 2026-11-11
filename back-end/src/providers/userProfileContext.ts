/** Shared personal identity and delivery context for interactive model surfaces. */

export interface UserProfileContext {
  userId: string;
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
  systemName: string | null;
}

export const USER_PROFILE_SELECT = {
  userId: true,
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
  systemName: true,
} as const;

export function formatUserContext(user: UserProfileContext | null): string {
  if (!user) return '';

  const parts = ['# User Context\n'];

  // Assistant name is per-user (the user's chosen `systemName`, default "Rose").
  // It lives here in the per-user Block 2 rather than the shared, user-agnostic
  // ROSE_CORE so Block 1 stays byte-identical across the whole fleet.
  const assistantName = user.systemName || 'Rose';
  parts.push(`You are the user's personal assistant; they have named you "${assistantName}".`);

  const personalInformation = [];
  if (user.name) personalInformation.push(`Full Name: ${user.name}`);
  if (user.phone) personalInformation.push(`Phone: ${user.phone}`);
  if (user.email) personalInformation.push(`Email: ${user.email}`);
  if (personalInformation.length > 0) {
    parts.push(`## Personal Information\n${personalInformation.join('\n')}`);
  }

  // Delivery address identity is independent from the account owner's identity.
  const addressParts = [user.addressLine1, user.addressLine2].filter(Boolean);
  const cityStateZip = [user.city, user.state, user.postalCode].filter(Boolean).join(', ');
  if (user.deliveryRecipientName || addressParts.length > 0 || cityStateZip) {
    const fullAddress = [
      user.deliveryRecipientName ? `Recipient Name: ${user.deliveryRecipientName}` : null,
      ...addressParts,
      cityStateZip,
      user.country,
    ]
      .filter(Boolean)
      .join('\n');
    parts.push(`## Delivery Address\n${fullAddress}`);
  } else {
    const locationParts = [user.city, user.state, user.country].filter(Boolean);
    if (locationParts.length > 0) {
      parts.push(`Location: ${locationParts.join(', ')}`);
    }
  }

  return parts.join('\n');
}
