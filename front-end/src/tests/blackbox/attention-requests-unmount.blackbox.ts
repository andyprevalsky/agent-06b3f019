/**
 * useAttentionRequests must release its `user:<id>` channel when the owner
 * unmounts while the Supabase join is still pending.
 *
 * Evidence (PR #1627 front-end coverage lane): app-wiring tests that mount the
 * Terminal with a session finish before the mock WebSocket answers the
 * `user:test-user` join. The hook's cleanup only knew channels that had already
 * reached SUBSCRIBED, so the joining channel stayed registered on the Supabase
 * client with phoenix's 10s join timeout armed. The shared setup then silenced
 * the socket without a close event, and ten seconds later, under a later test or
 * after Vitest had torn the file down, the timeout logged TIMED_OUT plus
 * "Failed to subscribe", surfacing as
 * `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`.
 *
 * These cases drive the mock socket one timer at a time so the join frame is
 * sent (timeout armed) but unanswered, exactly the state every session test
 * ended in, then unmount and let the whole timeout window elapse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { supabase } from '@/lib/supabase';
import { useAttentionRequests } from '@/features/terminal-component-group/components/attention-inbox/useAttentionRequests';

const USER_ID = 'pending-join-user';
const TOPIC = `realtime:user:${USER_ID}`;
const LATE_LOG = /TIMED_OUT|Failed to subscribe to attention requests|Channel disconnected/;

function seedSession() {
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: USER_ID, is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
}

/** The shared setup's MockWebSocket exposes disposeAll(); its afterEach calls it. */
function silenceLiveSockets() {
  (window.WebSocket as unknown as { disposeAll: () => void }).disposeAll();
}

function channelTopics(): string[] {
  return supabase.getChannels().map((channel) => channel.topic);
}

describe('useAttentionRequests pending-join teardown', () => {
  let messages: string[];
  let sendSpy: ReturnType<typeof vi.spyOn>;

  const joinSent = () =>
    sendSpy.mock.calls.some(([frame]) => typeof frame === 'string' && frame.includes('"phx_join"'));

  /** Fire mock-socket timers one at a time until `reached()` holds. */
  async function driveUntil(reached: () => boolean, what: string) {
    for (let step = 0; step < 20 && !reached(); step += 1) {
      await act(async () => {
        await vi.advanceTimersToNextTimerAsync();
      });
    }
    expect(reached(), what).toBe(true);
  }

  /** Stop right after the join frame is on the wire: timeout armed, reply pending. */
  const driveUntilJoinSent = () => driveUntil(joinSent, 'join frame sent');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    messages = [];
    const capture = (...args: unknown[]) => {
      messages.push(
        args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '),
      );
    };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
    sendSpy = vi.spyOn(window.WebSocket.prototype, 'send');
    localStorage.clear();
    seedSession();
  });

  afterEach(async () => {
    cleanup();
    await supabase.removeAllChannels();
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('unmounting while the join is unanswered removes the channel and arms no late log', async () => {
    renderHook(() => useAttentionRequests(true));
    await driveUntilJoinSent();
    expect(channelTopics()).toEqual([TOPIC]);
    expect(supabase.getChannels()[0]?.state).toBe('joining');

    cleanup();
    const topicsRightAfterUnmount = channelTopics();

    // What the shared setup's afterEach does next, then the whole timeout window.
    silenceLiveSockets();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(messages.filter((message) => LATE_LOG.test(message))).toEqual([]);
    // Releasing the owner must have released the pending channel immediately.
    expect(topicsRightAfterUnmount).toEqual([]);
    expect(channelTopics()).toEqual([]);
  });

  it('unmounting before the join frame is sent never registers a channel', async () => {
    renderHook(() => useAttentionRequests(true));
    // Cleanup runs while setup() is still awaiting ensureFreshRealtimeAuth().
    cleanup();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(joinSent()).toBe(false);
    expect(channelTopics()).toEqual([]);
    expect(messages.filter((message) => LATE_LOG.test(message))).toEqual([]);
  });

  it('a subscribed channel is still left normally on unmount', async () => {
    renderHook(() => useAttentionRequests(true));
    await driveUntilJoinSent();
    await driveUntil(() => supabase.getChannels()[0]?.state === 'joined', 'join acknowledged');
    expect(messages.some((message) => message.includes(`✅ Connected to user:${USER_ID}`))).toBe(
      true,
    );

    cleanup();
    // The leave is acknowledged by the mock socket on its next timer.
    await driveUntil(() => channelTopics().length === 0, 'leave acknowledged');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(channelTopics()).toEqual([]);
    expect(messages.filter((message) => LATE_LOG.test(message))).toEqual([]);
  });
});
