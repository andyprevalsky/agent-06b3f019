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

export interface SupabaseEnv {
  url: string;
  serviceKey: string;
}

/** Read Supabase credentials from env, or null if either is missing. */
export function readSupabaseEnv(): SupabaseEnv | null {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}

/** Table storing API keys. */
export const API_KEY_TABLE = 'RoseApiKey';

/** Prefix used to detect Bearer tokens in the Authorization header. */
export const BEARER_PREFIX = 'Bearer ';
