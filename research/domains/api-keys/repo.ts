/**
 * API Keys Domain — Repo
 *
 * Data access for RoseApiKey rows. Framework-agnostic: typed args in,
 * typed results out. No request/response handling, no business logic.
 */

import { API_KEYS_TABLE } from './config.ts';
import type { ApiKeyRow, SupabaseClient } from './types.ts';

export interface AuthResult {
  userId: string | null;
  error: string | null;
}

export async function getUserFromToken(
  supabase: SupabaseClient,
  token: string,
): Promise<AuthResult> {
  // deno-lint-ignore no-explicit-any
  const response = await (supabase as any).auth.getUser(token);
  const user = response?.data?.user ?? null;
  const error = response?.error ?? null;

  if (error || !user) {
    return { userId: null, error: error?.message ?? 'Unauthorized' };
  }
  return { userId: user.id, error: null };
}

export interface ListApiKeysQuery {
  data: ApiKeyRow[] | null;
  error: { message: string } | null;
}

export async function listApiKeysByUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<ListApiKeysQuery> {
  // deno-lint-ignore no-explicit-any
  const result = await (supabase as any)
    .from(API_KEYS_TABLE)
    .select('id, name, apiKey, createdAt')
    .eq('userId', userId)
    .order('createdAt', { ascending: false });

  return {
    data: (result?.data as ApiKeyRow[] | null) ?? null,
    error: result?.error ?? null,
  };
}
