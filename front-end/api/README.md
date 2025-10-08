# Vercel Edge Runtime API

This directory contains Vercel Edge Functions for authentication.

## Endpoints

### `POST /api/auth/login`
Initiates OAuth login flow.

**Request:**
```json
{
  "provider": "github"
}
```

**Response:**
```json
{
  "url": "https://github.com/login/oauth/authorize?..."
}
```

### `GET /api/auth/callback`
Handles OAuth callback from providers.

**Query Parameters:**
- `code` - Authorization code
- `error` - Error message (if failed)
- `error_description` - Error details

**Redirects to:** `/terminal` on success

### `POST /api/auth/logout`
Signs out the current user.

**Response:**
```json
{
  "success": true
}
```

### `GET /api/auth/user`
Returns the currently authenticated user.

**Response:**
```json
{
  "user": {
    "id": "...",
    "email": "user@example.com",
    "user_metadata": {},
    ...
  }
}
```

## Configuration

All functions use the Vercel Edge Runtime configured in `vercel.json`:

```json
{
  "functions": {
    "api/**/*.ts": {
      "runtime": "edge"
    }
  }
}
```

## Environment Variables

Required environment variables:
- `VITE_SUPABASE_URL` - Supabase project URL
- `VITE_SUPABASE_ANON_KEY` - Supabase anonymous key
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key (server-side only)

## Development

These functions are automatically served by Vercel during development and production.

**Local:** `http://localhost:8080/api/auth/*`
**Production:** `https://your-domain.com/api/auth/*`

## Security

- All functions validate environment variables
- Session tokens stored in httpOnly cookies
- Service role key never exposed to client
- PKCE flow for OAuth security


