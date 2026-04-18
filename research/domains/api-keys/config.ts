/**
 * API Keys Domain — Config
 *
 * Constants and env reads for the list-api-keys edge function.
 */

export const API_KEYS_TABLE = 'RoseApiKey';

export const MASK_SUFFIX_LENGTH = 4;

export const CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

export const JSON_HEADERS: Readonly<Record<string, string>> = {
  ...CORS_HEADERS,
  'Content-Type': 'application/json',
};

export interface SupabaseEnv {
  url: string;
  serviceKey: string;
}

export function readSupabaseEnv(): SupabaseEnv | null {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}
