/**
 * OpenAI-compatible /chat/completions endpoint.
 * 
 * This function handles the /chat/completions path that OpenAI SDK and litellm expect.
 * It simply re-exports the completions function logic.
 * 
 * URL: /functions/v1/chat/completions
 */

// Import and re-export the completions handler
// Since Supabase Edge Functions run in Deno, we can import from relative path
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// We'll forward the request to the completions function
// The simplest approach is to just proxy the request

const COMPLETIONS_URL = Deno.env.get("SUPABASE_URL") + "/functions/v1/completions";

serve(async (req: Request) => {
  // Get the path after /chat - should be /completions
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/chat/, "");
  
  // Only allow /completions path
  if (path !== "/completions" && path !== "") {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Forward to completions function
  try {
    const body = await req.text();
    
    const response = await fetch(COMPLETIONS_URL, {
      method: req.method,
      headers: req.headers,
      body: body || undefined,
    });

    // Stream the response back
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    console.error("Error proxying to completions:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

