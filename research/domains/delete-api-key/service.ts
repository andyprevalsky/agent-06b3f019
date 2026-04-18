/**
 * Business logic for the delete-api-key domain.
 *
 * Validates the caller and input, calls repo to delete, and maps DB errors
 * into typed domain errors. Knows nothing about HTTP.
 */

import { deleteApiKey, getUserFromToken } from './repo.ts';
import {
  DeleteApiKeyError,
  type DeleteApiKeyServiceArgs,
  type DeleteApiKeyServiceResult,
} from './types.ts';

/**
 * Delete the API key identified by `keyId` if it belongs to the user
 * authenticated by `token`. Zero-row deletes are treated as success
 * (idempotent and tenant-safe — the eq('userId', …) clause is the guard).
 */
export async function deleteApiKeyForCaller(
  args: DeleteApiKeyServiceArgs,
): Promise<DeleteApiKeyServiceResult> {
  const { supabase, token, keyId } = args;

  if (!keyId) {
    throw new DeleteApiKeyError('missing_key_id', 'Missing required field: keyId');
  }

  const { data: { user }, error: userError } = await getUserFromToken(supabase, token);
  if (userError || !user) {
    throw new DeleteApiKeyError('unauthorized', 'Unauthorized');
  }

  const { error } = await deleteApiKey({ supabase, keyId, userId: user.id });
  if (error) {
    throw new DeleteApiKeyError('db_error', 'Failed to delete API key', error.message);
  }

  return { success: true, message: 'API key deleted successfully' };
}
