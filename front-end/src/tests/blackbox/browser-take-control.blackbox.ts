/**
 * Owning-boundary coverage for same-session take-control.
 *
 * Prod agent 3b2a912a stalled taking control of the second live browser
 * because the client polled for a worker action-boundary ack (up to 120s)
 * instead of enabling the existing session immediately.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return {
    ...actual,
    getAuthHeaders: () => ({ 'Content-Type': 'application/json' }),
  };
});

import { takeBrowserControl } from '@/lib/api/browser-session';

describe('takeBrowserControl same-session handover', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('rejects a leftover requested snapshot so the iframe stays disabled', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        return new Response(
          JSON.stringify({
            state: 'requested',
            agentPaused: false,
            debugUrl: 'https://connect.steel.dev/v1/sessions/second/player?interactive=false',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    const started = Date.now();
    await expect(takeBrowserControl('task-second')).rejects.toThrow(
      'Browser agent did not hand control over in time',
    );
    const elapsedMs = Date.now() - started;

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^POST /);
    expect(calls[0]).toContain('/browser-session/task/task-second/control');
    expect(elapsedMs).toBeLessThan(250);
  });

  it('enables the same live session when the backend grants user immediately', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        return new Response(
          JSON.stringify({
            state: 'user',
            agentPaused: false,
            debugUrl: 'https://connect.steel.dev/v1/sessions/second/player?interactive=false',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    const snapshot = await takeBrowserControl('task-second');
    expect(snapshot.state).toBe('user');
    expect(snapshot.debugUrl).toContain('sessions/second');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^POST /);
  });
});
