import { serve } from 'https://deno.land/std@0.190.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@~2.39.3';
import { createHandler } from '../../../domains/delete-api-key/handler.ts';

// deno-lint-ignore no-explicit-any
serve(createHandler(createClient as any));
