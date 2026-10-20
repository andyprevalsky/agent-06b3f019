/** Account row label for the Rose left bar (UI ledger row 63). */

import type { User } from '@supabase/supabase-js';

function metadataName(user: User): string {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  for (const key of ['full_name', 'name', 'first_name']) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/** Human label for the account row: profile name, else email local part, else phone. */
export function accountDisplayName(user: User): string {
  const name = metadataName(user);
  if (name !== '') return name;
  const email = user.email ?? '';
  if (email !== '') return email.split('@')[0] ?? email;
  return user.phone ?? 'Account';
}
