/**
 * OpenAI-compatible /chat/completions proxy (Supabase runtime entry).
 *
 * Thin wiring: hands Fetch `Request`s to the framework-agnostic chat runtime
 * adapter in `research/domains/chat/runtime.ts`.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { handleChatHttpRequest } from '../../../domains/chat/runtime.ts';

serve(handleChatHttpRequest);
