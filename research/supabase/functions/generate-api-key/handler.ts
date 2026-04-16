/**
 * Generate API Key Handler
 *
 * Creates a new 32-character API key for the authenticated user.
 * Extracted from index.ts for testability.
 */

export interface SupabaseClient {
  auth: {
    getUser(token: string): Promise<{
      data: { user: { id: string; [key: string]: unknown } | null };
      error: { message: string } | null;
    }>;
  };
  from(table: string): unknown;
}

export type CreateClientFn = (url: string, key: string) => SupabaseClient;

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

export function createHandler(
  createClient: CreateClientFn,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Extract auth token
      const authHeader = req.headers.get('authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response(
          JSON.stringify({
            error: 'Missing or invalid authorization header',
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 401,
          },
        );
      }

      const token = authHeader.substring(7);

      // Initialize Supabase client
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      if (!supabaseUrl || !supabaseServiceKey) {
        return new Response(
          JSON.stringify({ error: 'Server misconfiguration: missing Supabase credentials' }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500,
          },
        );
      }
      const supabase = createClient(supabaseUrl, supabaseServiceKey);

      // Verify user from JWT
      // deno-lint-ignore no-explicit-any
      const { data: { user }, error: userError } = await (supabase as any).auth.getUser(token);

      if (userError || !user) {
        return new Response(
          JSON.stringify({
            error: 'Unauthorized',
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 401,
          },
        );
      }

      // Parse request body (handles empty body, null, and non-JSON gracefully)
      const body = await req.json().catch(() => null);
      const name = body?.name ?? null;

      // Generate 32-character API key
      const apiKey = crypto.randomUUID().replace(/-/g, '');

      // Insert into database
      // deno-lint-ignore no-explicit-any
      const { data, error } = await (supabase as any)
        .from('RoseApiKey')
        .insert({
          userId: user.id,
          apiKey,
          name,
        })
        .select('id, apiKey, createdAt')
        .single();

      if (error) {
        return new Response(
          JSON.stringify({
            error: 'Failed to create API key',
            details: error.message,
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500,
          },
        );
      }

      return new Response(
        JSON.stringify({
          apiKey: data.apiKey,
          id: data.id,
          createdAt: data.createdAt,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        },
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return new Response(
        JSON.stringify({
          error: 'Internal server error',
          details: errorMessage,
        }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 500,
        },
      );
    }
  };
}
