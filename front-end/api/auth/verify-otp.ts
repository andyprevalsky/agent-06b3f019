/// <reference types="node" />

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request) {
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }), 
      { status: 405, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const { phone, token } = await req.json();
    
    if (!phone || !token) {
      return new Response(
        JSON.stringify({ error: 'Phone number and OTP are required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return new Response(
        JSON.stringify({ error: 'Supabase configuration missing' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Verify OTP with Supabase
    const response = await fetch(`${supabaseUrl}/auth/v1/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
      },
      body: JSON.stringify({
        type: 'sms',
        phone,
        token,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: data.error_description || data.msg || 'Invalid OTP' }),
        { status: response.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Set session cookies with 30-day expiration
    if (data.access_token) {
      const cookies: string[] = [];
      const thirtyDaysInSeconds = 60 * 60 * 24 * 30;
      const isProduction = process.env.NODE_ENV === 'production';
      
      cookies.push(
        `sb-access-token=${data.access_token}; Path=/; HttpOnly; ${isProduction ? 'Secure;' : ''} SameSite=Lax; Max-Age=${data.expires_in || thirtyDaysInSeconds}`
      );

      if (data.refresh_token) {
        cookies.push(
          `sb-refresh-token=${data.refresh_token}; Path=/; HttpOnly; ${isProduction ? 'Secure;' : ''} SameSite=Lax; Max-Age=${thirtyDaysInSeconds}`
        );
      }

      return new Response(
        JSON.stringify({ 
          success: true, 
          user: data.user,
          redirectTo: '/terminal'
        }),
        { 
          status: 200, 
          headers: { 
            'Content-Type': 'application/json',
            'Set-Cookie': cookies.join(', '),
          } 
        }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Authentication failed' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Verify OTP error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

