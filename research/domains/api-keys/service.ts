/**
 * API Keys Domain — Service
 *
 * Business logic for listing a user's API keys with masked secrets.
 * Typed args in, typed results out. Calls repo for data access.
 */

import { MASK_SUFFIX_LENGTH } from './config.ts';
import { getUserFromToken, listApiKeysByUser } from './repo.ts';
import type { ApiKeyRow, ListApiKeysResult, MaskedApiKey, SupabaseClient } from './types.ts';

function maskKey(row: ApiKeyRow): MaskedApiKey {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    maskedApiKey: `...${row.apiKey.slice(-MASK_SUFFIX_LENGTH)}`,
  };
}

export async function listApiKeysForToken(
  supabase: SupabaseClient,
  token: string,
): Promise<ListApiKeysResult> {
  const auth = await getUserFromToken(supabase, token);
  if (!auth.userId) {
    return { kind: 'error', status: 401, error: 'Unauthorized' };
  }

  const query = await listApiKeysByUser(supabase, auth.userId);
  if (query.error) {
    return {
      kind: 'error',
      status: 500,
      error: 'Failed to fetch API keys',
      details: query.error.message,
    };
  }

  const keys = (query.data ?? []).map(maskKey);
  return { kind: 'ok', keys };
}
