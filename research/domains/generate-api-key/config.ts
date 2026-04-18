/**
 * Config for the generate-api-key domain.
 *
 * Magic constants, defaults, and shared response headers.
 */

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
} as const;

export const jsonResponseHeaders = {
  ...corsHeaders,
  'Content-Type': 'application/json',
} as const;

/** Database table that stores API keys. */
export const API_KEY_TABLE = 'RoseApiKey';

/** Columns selected after the insert to build the response body. */
export const API_KEY_RESPONSE_COLUMNS = 'id, apiKey, createdAt';

/** Env var names read at request time. */
export const ENV_SUPABASE_URL = 'SUPABASE_URL';
export const ENV_SUPABASE_SERVICE_ROLE_KEY = 'SUPABASE_SERVICE_ROLE_KEY';
