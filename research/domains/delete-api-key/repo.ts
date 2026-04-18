/**
 * Data access for the delete-api-key domain.
 *
 * Wraps Supabase calls: user lookup from JWT and scoped DELETE on RoseApiKey.
 * No business logic — just typed args in, typed results out.
 */

import { API_KEY_TABLE } from './config.ts';
import type {
  DeleteApiKeyRepoArgs,
  DeleteApiKeyRepoResult,
  SupabaseClient,
  SupabaseGetUserResult,
} from './types.ts';

/** Minimal shape of the Supabase query builder used by deleteApiKey. */
interface DeleteQueryBuilder {
  delete(): DeleteQueryBuilder;
  eq(column: string, value: string): DeleteQueryBuilder;
  then<TResult1 = DeleteApiKeyRepoResult, TResult2 = never>(
    onfulfilled?:
      | ((value: DeleteApiKeyRepoResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
}

/** Resolve the authenticated user for a Bearer token. */
export async function getUserFromToken(
  supabase: SupabaseClient,
  token: string,
): Promise<SupabaseGetUserResult> {
  return await supabase.auth.getUser(token);
}

/** Delete an API key scoped to its owning user. Zero-row deletes are not errors. */
export async function deleteApiKey(
  args: DeleteApiKeyRepoArgs,
): Promise<DeleteApiKeyRepoResult> {
  const { supabase, keyId, userId } = args;
  const table = supabase.from(API_KEY_TABLE) as DeleteQueryBuilder;
  const { error } = await table
    .delete()
    .eq('id', keyId)
    .eq('userId', userId);
  return { error: error ?? null };
}
