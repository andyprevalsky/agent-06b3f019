/**
 * Config for the delete-api-key domain.
 *
 * CORS headers, env var keys, and the DB table name. Constants only —
 * no side effects at import time.
 */

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

export const jsonContentTypeHeaders: Record<string, string> = {
  ...corsHeaders,
  'Content-Type': 'application/json',
};

/** Env var keys read by the service layer at runtime. */
export const ENV_SUPABASE_URL = 'SUPABASE_URL';
export const ENV_SUPABASE_SERVICE_ROLE_KEY = 'SUPABASE_SERVICE_ROLE_KEY';

/** Table storing API keys. */
export const API_KEY_TABLE = 'RoseApiKey';

/** Prefix used to detect Bearer tokens in the Authorization header. */
export const BEARER_PREFIX = 'Bearer ';
