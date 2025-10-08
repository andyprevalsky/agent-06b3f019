/// <reference types="node" />

export const config = {
  runtime: 'edge',
};

function getCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';').map(c => c.trim());
  for (const cookie of cookies) {
    const [key, value] = cookie.split('=');
    if (key === name) return value;
  }
  return null;
}

export default async function handler(req: Request) {
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const cookieHeader = req.headers.get('cookie');
    const accessToken = getCookie(cookieHeader, 'sb-access-token');
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;

    if (accessToken && supabaseUrl && supabaseKey) {
      // Call Supabase logout endpoint
      await fetch(`${supabaseUrl}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'apikey': supabaseKey,
        },
      });
    }

    // Clear cookies by setting them to expire
    const clearCookies = [
      'sb-access-token=; Path=/; HttpOnly; Max-Age=0',
      'sb-refresh-token=; Path=/; HttpOnly; Max-Age=0',
    ];

    return new Response(
      JSON.stringify({ success: true }),
      { 
        status: 200, 
        headers: { 
          'Content-Type': 'application/json',
          'Set-Cookie': clearCookies.join(', '),
        } 
      }
    );
  } catch (error) {
    console.error('Logout error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}


