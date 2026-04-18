import { serve } from 'https://deno.land/std@0.190.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@~2.39.3';
import { createHandler } from '../../../domains/generate-api-key/runtime.ts';
import type { CreateClientFn } from '../../../domains/generate-api-key/types.ts';

serve(createHandler(createClient as unknown as CreateClientFn));
