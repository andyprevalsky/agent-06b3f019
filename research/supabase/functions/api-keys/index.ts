import { serve } from 'https://deno.land/std@0.190.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@~2.39.3';
import { createHandler } from '../../../domains/api-keys/handler.ts';
import type { CreateClientFn } from '../../../domains/api-keys/handler.ts';

serve(createHandler(createClient as unknown as CreateClientFn));
