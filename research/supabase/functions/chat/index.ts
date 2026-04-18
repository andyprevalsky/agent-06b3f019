/**
 * OpenAI-compatible /chat/completions proxy (Supabase runtime entry).
 *
 * Thin wrapper that adapts the Supabase edge function runtime to the
 * framework-agnostic chat proxy service in research/domains/chat/.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { handleChatRequest } from '../../../domains/chat/service.ts';

serve((req: Request): Promise<Response> => {
  const url = new URL(req.url);
  return handleChatRequest({
    method: req.method,
    pathname: url.pathname,
    headers: req.headers,
    readBody: () => req.text(),
  });
});
