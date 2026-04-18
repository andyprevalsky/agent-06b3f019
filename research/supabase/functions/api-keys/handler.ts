/**
 * Thin re-export shim.
 *
 * The real implementation lives in `research/domains/api-keys/`.
 * This file exists so that the Supabase function folder stays next to its
 * runtime entry (`index.ts`) and so that existing test imports keep working.
 */

export { corsHeaders, createHandler } from '../../../domains/api-keys/handler.ts';
export type { CreateClientFn, SupabaseClient } from '../../../domains/api-keys/handler.ts';
