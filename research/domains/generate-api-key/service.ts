/**
 * Business logic for the generate-api-key domain.
 *
 * Orchestrates:
 *   1. Env-backed Supabase client construction
 *   2. JWT verification
 *   3. API-key generation
 *   4. Database insert via the repo layer
 *
 * Inputs and outputs are typed; HTTP concerns live in the runtime layer.
 */

import { ENV_SUPABASE_SERVICE_ROLE_KEY, ENV_SUPABASE_URL } from './config.ts';
import { findUserByJwt, insertApiKey } from './repo.ts';
import type { CreateClientFn, GenerateApiKeyResponseBody, SupabaseClient } from './types.ts';
import { GenerateApiKeyError } from './types.ts';

/** Build a Supabase client from env, or throw a typed 500. */
export function buildSupabaseClient(createClient: CreateClientFn): SupabaseClient {
  const supabaseUrl = Deno.env.get(ENV_SUPABASE_URL);
  const supabaseServiceKey = Deno.env.get(ENV_SUPABASE_SERVICE_ROLE_KEY);
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new GenerateApiKeyError(500, 'Server misconfiguration: missing Supabase credentials');
  }
  return createClient(supabaseUrl, supabaseServiceKey);
}

/** Generate a 32-character hex API key (UUID without dashes). */
export function generateApiKeyString(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export interface GenerateApiKeyParams {
  supabase: SupabaseClient;
  token: string;
  name: string | null | undefined;
}

/**
 * Core business operation: verify the JWT, mint a new key, persist it, and
 * return the row. Throws {@link GenerateApiKeyError} for every expected
 * failure mode so the runtime layer can map to an HTTP status.
 */
export async function generateApiKey(
  params: GenerateApiKeyParams,
): Promise<GenerateApiKeyResponseBody> {
  const user = await findUserByJwt(params.supabase, params.token);
  if (!user) {
    throw new GenerateApiKeyError(401, 'Unauthorized');
  }

  const apiKey = generateApiKeyString();
  const { row, error } = await insertApiKey(params.supabase, {
    userId: user.id,
    apiKey,
    name: params.name,
  });

  if (error || !row) {
    throw new GenerateApiKeyError(500, 'Failed to create API key', error ?? undefined);
  }

  return {
    apiKey: row.apiKey,
    id: row.id,
    createdAt: row.createdAt,
  };
}
