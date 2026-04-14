/**
 * API Keys List Handler
 *
 * Lists all API keys for the authenticated user, with keys masked.
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

export function createHandler(createClient: CreateClientFn) {
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

      // Fetch user's API keys
      // deno-lint-ignore no-explicit-any
      const { data, error } = await (supabase as any)
        .from('RoseApiKey')
        .select('id, name, apiKey, createdAt')
        .eq('userId', user.id)
        .order('createdAt', { ascending: false });

      if (error) {
        return new Response(
          JSON.stringify({
            error: 'Failed to fetch API keys',
            details: error.message,
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500,
          },
        );
      }

      // Mask API keys (show only last 4 characters)
      // deno-lint-ignore no-explicit-any
      const maskedKeys = (data || []).map((key: any) => ({
        id: key.id,
        name: key.name,
        createdAt: key.createdAt,
        maskedApiKey: `...${key.apiKey.slice(-4)}`,
      }));

      return new Response(
        JSON.stringify({
          keys: maskedKeys,
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
