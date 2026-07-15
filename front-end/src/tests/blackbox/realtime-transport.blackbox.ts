import { afterEach, describe, expect, it } from 'vitest';
import { subscribeToChannel } from '@/lib/realtime';
import { supabase } from '@/lib/supabase';

function storeTestSession(): void {
  localStorage.setItem(
    'rose-session',
    JSON.stringify({
      access_token: 'test-realtime-token',
      refresh_token: 'test-realtime-refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: { id: 'realtime-transport-user', is_anonymous: false },
    }),
  );
}

async function within<T>(promise: PromiseLike<T>, timeoutMs = 1_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Realtime transport timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe('blackbox realtime transport', () => {
  afterEach(async () => {
    await within(supabase.removeAllChannels());
    localStorage.clear();
  });

  it('subscribes, leaves, and resubscribes the same Phoenix topic', async () => {
    storeTestSession();

    const first = await within(subscribeToChannel('test:phoenix-transport', {}));
    expect(first.state).toBe('joined');
    expect(await within(supabase.removeChannel(first))).toBe('ok');

    const second = await within(subscribeToChannel('test:phoenix-transport', {}));
    expect(second.state).toBe('joined');
    expect(await within(supabase.removeChannel(second))).toBe('ok');
  });

  it('surfaces the join-error reason on CHANNEL_ERROR instead of a bare error', async () => {
    storeTestSession();

    // The mock rejects joins for topics containing "deny-join" with
    // { reason: 'access denied' }. subscribeToChannel must propagate that reason
    // — a bare "Channel error" would hide auth/RLS vs transport failures and make
    // intermittent subscription drops undiagnosable.
    await expect(within(subscribeToChannel('test:deny-join', {}))).rejects.toThrow(/access denied/);
  });
});
