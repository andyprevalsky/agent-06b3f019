/**
 * Chat domain configuration.
 *
 * Constants and environment reads for the chat -> completions proxy.
 */

import type { CorsHeaders } from './types.ts';

export const CORS_HEADERS: CorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-api-key, x-request-id, x-agent-id, x-call-site',
};

/** Prefix stripped from inbound request paths before matching. */
export const CHAT_PATH_PREFIX = /^\/chat/;

/** Paths that are valid after the /chat prefix is stripped. */
export const ALLOWED_SUBPATHS: ReadonlySet<string> = new Set(['/completions', '']);

/** Returns the upstream completions URL built from SUPABASE_URL at call time. */
export function getCompletionsUrl(): string {
  const base = Deno.env.get('SUPABASE_URL') ?? '';
  return `${base}/functions/v1/completions`;
}
