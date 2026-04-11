/**
 * OpenAI-compatible /chat/completions proxy.
 *
 * Forwards requests to the completions edge function so OpenAI SDK and litellm
 * can hit /functions/v1/chat/completions (the path they expect).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const COMPLETIONS_URL = Deno.env.get('SUPABASE_URL') + '/functions/v1/completions';

serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/chat/, '');

  if (path !== '/completions' && path !== '') {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.text();

    const response = await fetch(COMPLETIONS_URL, {
      method: req.method,
      headers: req.headers,
      body: body || undefined,
    });

    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    // deno-lint-ignore no-console -- Edge function error logging (Deno has no other logging API)
    console.error('Error proxying to completions:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
