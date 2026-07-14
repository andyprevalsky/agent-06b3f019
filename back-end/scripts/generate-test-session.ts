/**
 * Generate a valid authenticated session for browser semantic tests.
 *
 * Local runs use SUPABASE_JWT_SECRET and the configured test user. CI can use
 * the existing SUPABASE_SERVICE_ROLE_KEY instead; that path signs in a
 * dedicated, non-privileged ratchet account and never exposes the service key
 * to the browser.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';

import { createClient, type Session } from '@supabase/supabase-js';

import { generateSupabaseSession } from '../src/domains/auth/service.session';

const TEST_USER_ID = process.env.TEST_USER_ID ?? '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const TEST_PHONE = process.env.TEST_PHONE_E164 ?? '+19729777432';
const RATCHET_EMAIL = process.env.CHAT_RATCHET_EMAIL ?? 'chat-lifecycle-ratchet@roselabs.ai';

function localSignedSession(): Record<string, unknown> {
  const tokens = generateSupabaseSession(TEST_USER_ID, TEST_PHONE);
  return {
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
}

function ratchetPassword(serviceRoleKey: string): string {
  return createHash('sha256')
    .update(`chat-lifecycle-ratchet:${serviceRoleKey}`)
    .digest('base64url');
}

async function findRatchetUserId(
  supabase: ReturnType<typeof createClient>
): Promise<string | null> {
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error(`Could not list ratchet users: ${error.message}`);
    const user = data.users.find((candidate) => candidate.email === RATCHET_EMAIL);
    if (user) return user.id;
    if (data.users.length < 100) return null;
  }
  throw new Error('Could not find ratchet user within the first 1,000 auth users');
}

async function serviceRoleSession(): Promise<Session> {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      'SUPABASE_JWT_SECRET or both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required'
    );
  }

  const supabase = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const password = ratchetPassword(serviceRoleKey);
  let userId = await findRatchetUserId(supabase);

  if (!userId) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: RATCHET_EMAIL,
      password,
      email_confirm: true,
      user_metadata: { purpose: 'chat-lifecycle-ratchet' },
    });
    if (error) {
      userId = await findRatchetUserId(supabase);
      if (!userId) throw new Error(`Could not create ratchet user: ${error.message}`);
    } else {
      userId = data.user.id;
    }
  }

  const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
    password,
    email_confirm: true,
  });
  if (updateError) throw new Error(`Could not update ratchet user: ${updateError.message}`);

  const { data, error } = await supabase.auth.signInWithPassword({
    email: RATCHET_EMAIL,
    password,
  });
  if (error || !data.session) {
    throw new Error(`Could not sign in ratchet user: ${error?.message ?? 'session missing'}`);
  }
  return data.session;
}

async function main(): Promise<void> {
  const session = process.env.SUPABASE_JWT_SECRET
    ? localSignedSession()
    : await serviceRoleSession();
  process.stdout.write(JSON.stringify(session));
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
