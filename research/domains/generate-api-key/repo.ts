/**
 * Data-access layer for the generate-api-key domain.
 *
 * Wraps the Supabase SDK calls this domain needs: resolving a user from a JWT
 * and inserting a row into the RoseApiKey table. The service layer never
 * touches the Supabase client directly.
 */

import { API_KEY_RESPONSE_COLUMNS, API_KEY_TABLE } from './config.ts';
import type { InsertedApiKeyRow, SupabaseClient, SupabaseUser } from './types.ts';

/** Resolve the Supabase user from a Bearer JWT. Returns null on failure. */
export async function findUserByJwt(
  supabase: SupabaseClient,
  token: string,
): Promise<SupabaseUser | null> {
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

/** Payload accepted by {@link insertApiKey}. */
export interface InsertApiKeyArgs {
  userId: string;
  apiKey: string;
  name: string | null | undefined;
}

/** Result of a RoseApiKey insert. Either a row or a Supabase error message. */
export interface InsertApiKeyResult {
  row: InsertedApiKeyRow | null;
  error: string | null;
}

/**
 * Insert a new RoseApiKey row and return the resulting id/apiKey/createdAt.
 *
 * The structural {@link SupabaseClient} type only describes the subset of the
 * SDK this domain relies on; the query-builder chain (`.insert().select()
 * .single()`) lives outside that surface, so we cast once here and keep the
 * runtime/service layers fully typed.
 */
export async function insertApiKey(
  supabase: SupabaseClient,
  args: InsertApiKeyArgs,
): Promise<InsertApiKeyResult> {
  // deno-lint-ignore no-explicit-any
  const table = supabase.from(API_KEY_TABLE) as any;
  const { data, error } = await table
    .insert({
      userId: args.userId,
      apiKey: args.apiKey,
      name: args.name,
    })
    .select(API_KEY_RESPONSE_COLUMNS)
    .single();

  if (error) return { row: null, error: error.message ?? 'unknown error' };
  return { row: data as InsertedApiKeyRow, error: null };
}
