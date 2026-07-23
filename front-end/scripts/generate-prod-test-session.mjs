import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { createClient } from '@supabase/supabase-js';

const RATCHET_EMAIL = process.env.CHAT_RATCHET_EMAIL ?? 'chat-lifecycle-ratchet@roselabs.ai';

export function ratchetPassword(serviceRoleKey) {
  return createHash('sha256')
    .update(`chat-lifecycle-ratchet:${serviceRoleKey}`)
    .digest('base64url');
}

async function findRatchetUserId(supabase) {
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error(`Could not list ratchet users: ${error.message}`);
    const user = data.users.find((candidate) => candidate.email === RATCHET_EMAIL);
    if (user) return user.id;
    if (data.users.length < 100) return null;
  }
}

export async function createProductionSession({
  url = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  createClientImpl = createClient,
} = {}) {
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }

  const supabase = createClientImpl(url, serviceRoleKey, {
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

async function main() {
  const session = await createProductionSession();
  process.stdout.write(JSON.stringify(session));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
