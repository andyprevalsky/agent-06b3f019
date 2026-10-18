import { iphoneCapability } from '../../providers/phoneAccountPolicy';
/**
 * User-settings domain service — business logic for user settings CRUD.
 */

import { type UpdateUserBody, type UserSettingsResponse, updateUserSchema } from './types';
import * as repo from './repo';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default response when no user record exists. */
const DEFAULT_SETTINGS: UserSettingsResponse = {
  name: null,
  email: null,
  phone: null,
  deliveryRecipientName: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  state: null,
  postalCode: null,
  country: 'United States',
  encryptedPaymentInformation: null,
  onboardingCompletedAt: null,
  systemName: null,
  profilePicture: null,
  customSystemPrompt: null,
  voicePreferenceId: null,
};

/** Map a Prisma user record to the response shape (GET includes phone + onboarding). */
function toGetResponse(user: {
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
  onboardingCompletedAt: Date | null;
  systemName: string | null;
  profilePicture: string | null;
  customSystemPrompt: string | null;
  voicePreferenceId: string | null;
}): UserSettingsResponse {
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
    onboardingCompletedAt: user.onboardingCompletedAt,
    systemName: user.systemName,
    profilePicture: user.profilePicture,
    customSystemPrompt: user.customSystemPrompt,
    voicePreferenceId: user.voicePreferenceId,
  };
}

/** Map a Prisma user record to the response shape (PUT/PATCH omits phone + onboarding). */
function toMutationResponse(user: {
  name: string | null;
  email: string | null;
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
  voicePreferenceId: string | null;
}): Omit<UserSettingsResponse, 'phone' | 'onboardingCompletedAt'> {
  return {
    name: user.name,
    email: user.email,
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
    voicePreferenceId: user.voicePreferenceId,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get user settings. Returns defaults if user record doesn't exist. */
export async function getUserSettings(userId: string): Promise<UserSettingsResponse> {
  const user = await repo.findUser(userId);
  if (!user) {
    return DEFAULT_SETTINGS;
  }
  return toGetResponse(user);
}

/** Full-replace upsert of user settings. */
export async function updateUserSettings(userId: string, body: UpdateUserBody) {
  const user = await repo.upsertUser(userId, body);
  return toMutationResponse(user);
}

/** Partial update of user settings. Creates if user doesn't exist. */
export async function patchUserSettings(userId: string, body: UpdateUserBody) {
  const existingUser = await repo.findUser(userId);

  if (!existingUser) {
    try {
      const user = await repo.createUser(userId, body);
      return toMutationResponse(user);
    } catch (error: unknown) {
      // Handle race condition: another request created the user first
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === 'P2002'
      ) {
        const user = await repo.partialUpdateUser(userId, body);
        return toMutationResponse(user);
      }
      throw error;
    }
  }

  const user = await repo.partialUpdateUser(userId, body);
  return toMutationResponse(user);
}

/** Re-export schema parse for routes layer. */
export function parseUpdateBody(raw: unknown): UpdateUserBody {
  return updateUserSchema.parse(raw);
}
