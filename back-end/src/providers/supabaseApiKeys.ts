import { createClient } from '@supabase/supabase-js';
import { randomBytes } from './crypto';
import { createLogger } from './logger';

const log = createLogger('SupabaseApiKeys');

export async function ensureRoseApiKeyForUser(userId: string): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (
    supabaseUrl === undefined ||
    supabaseUrl === '' ||
    supabaseServiceKey === undefined ||
    supabaseServiceKey === ''
  ) {
    log.error('Missing Supabase credentials for API key generation');
    return;
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const { data: existingKeys, error: fetchError } = await supabase
      .from('RoseApiKey')
      .select('id')
      .eq('userId', userId)
      .limit(1);
    if (fetchError !== null) {
      log.error('Error checking existing API keys', { error: String(fetchError) });
      return;
    }
    if (existingKeys !== null && existingKeys.length > 0) {
      log.info('User already has API keys, skipping auto-generation', { user_id: userId });
      return;
    }

    const apiKey = randomBytes(32).toString('base64url');
    const { error: insertError } = await supabase.from('RoseApiKey').insert({
      userId,
      apiKey,
      name: 'Default (auto-generated)',
    });
    if (insertError !== null) {
      log.error('Error creating API key', { error: String(insertError) });
      return;
    }
    log.info('Auto-generated Rose API key for user', { user_id: userId });
  } catch (error) {
    log.error('Error in ensureRoseApiKeyForUser', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
