/**
 * Generate a valid JWT session for the test user.
 *
 * Used by the semantic test runner (`--prod` flag) to inject an authenticated
 * session into Playwright's localStorage before navigating to the prod frontend.
 *
 * Usage:
 *   npx tsx scripts/generate-test-session.ts
 *   # outputs JSON to stdout: { access_token, refresh_token, expires_in, expires_at, token_type, user }
 *
 * Reads SUPABASE_JWT_SECRET and SUPABASE_URL from .env (same Supabase project
 * across all environments).
 */
import 'dotenv/config';
import { generateSupabaseSession } from '../src/domains/auth/service.session';

const TEST_USER_ID = process.env.TEST_USER_ID ?? '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const TEST_PHONE = process.env.TEST_PHONE_E164 ?? '+19729777432';

const tokens = generateSupabaseSession(TEST_USER_ID, TEST_PHONE);

const session = {
  ...tokens,
  user: {
    id: TEST_USER_ID,
    phone: TEST_PHONE,
    is_anonymous: false,
    aud: 'authenticated',
    role: 'authenticated',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    app_metadata: { provider: 'phone', providers: ['phone'] },
    user_metadata: {},
  },
};

// Single-line JSON to stdout for easy consumption by shell scripts
process.stdout.write(JSON.stringify(session));
