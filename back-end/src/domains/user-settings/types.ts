/**
 * User-settings domain types — Zod schemas, interfaces, type aliases.
 */

import { z } from 'zod';

// Validation schema for user data updates (PUT and PATCH)
export const updateUserSchema = z.object({
  name: z.string().optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  encryptedPaymentInformation: z.string().optional().nullable(),
  // Customization fields
  systemName: z.string().max(50).optional().nullable(),
  profilePicture: z.string().max(500).optional().nullable(),
  customSystemPrompt: z.string().max(2000).optional().nullable(),
  voicePreferenceId: z.string().max(100).optional().nullable(),
});

export type UpdateUserBody = z.infer<typeof updateUserSchema>;

/** Shape returned by GET / PUT / PATCH endpoints. */
export interface UserSettingsResponse {
  name: string | null;
  phone?: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  encryptedPaymentInformation: string | null;
  onboardingCompletedAt?: Date | null;
  systemName: string | null;
  profilePicture: string | null;
  customSystemPrompt: string | null;
  voicePreferenceId: string | null;
}
