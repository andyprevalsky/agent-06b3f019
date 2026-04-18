// deno-lint-ignore-file no-console -- Edge function: console is the only log channel
/**
 * Rose-Bench Edge Function Entry
 *
 * Thin Supabase runtime entry. Wires real dependencies into the layered
 * handler in `research/domains/rose-bench/runtime.ts`.
 */

import { serve } from 'https://deno.land/std@0.190.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@~2.39.3';
import { createHandler } from '../../../domains/rose-bench/runtime.ts';
import type { CreateSupabaseClientFn } from '../../../domains/rose-bench/types.ts';

serve(createHandler({
  createSupabaseClient: createClient as unknown as CreateSupabaseClientFn,
  logError: (message: string, err: unknown): void => {
    console.error(message, err);
  },
}));
