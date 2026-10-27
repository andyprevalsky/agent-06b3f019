/**
 * Account row label for the Rose left bar (UI ledger row 63).
 *
 * Order: the Rose profile name (backend User row, GET /api/user-settings - the
 * name Settings > Personal Info shows), then Supabase auth metadata, then the
 * email local part, then the phone. Phone-OTP sign-ins have empty metadata.
 */

import type { User } from '@supabase/supabase-js';

function metadataName(user: User): string {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  for (const key of ['full_name', 'name', 'first_name']) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/** Human label for the account row (see the order above). */
export function accountDisplayName(user: User, profileName: string | null = null): string {
  if (profileName !== null && profileName.trim() !== '') return profileName.trim();
  const name = metadataName(user);
  if (name !== '') return name;
  const email = user.email ?? '';
  if (email !== '') return email.split('@')[0] ?? email;
  return user.phone ?? 'Account';
}
