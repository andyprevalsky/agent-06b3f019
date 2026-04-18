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
