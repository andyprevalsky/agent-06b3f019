/**
 * Serialize Claude Code sandbox creates across every backend instance.
 *
 * Concurrent `createClaudeCodeSession` calls stampede E2B's reserve-script
 * redis pool and return HTTP 500 `redis: connection pool timeout` (local
 * repro: cuda-kernel-github-top100-code-agent k=3 r8/r9, 2026-09-03). Agents
 * often fan out several `spawn_claude_code_agent` tool calls at once; one
 * create at a time keeps the reserve path healthy while callers await their
 * turn. Failures (including E2B's fail-fast capacity error) still propagate to
 * the waiting caller and release the slot.
 *
 *   caller ─► per-process queue ─► shared lease lock (sharedState) ─► create
 *
 * The in-process queue keeps one waiter per instance polling the shared lock;
 * the lock makes the limit hold with N instances, not just within one.
 */
import { withSerializedLock } from './sharedState';

const CREATE_LOCK_KEY = 'e2b-claude-code-create';
// A create can take minutes, and fan-outs queue several of them.
const CREATE_LOCK_WAIT_MS = 15 * 60_000;

let claudeCodeCreateTail: Promise<void> = Promise.resolve();

export async function withClaudeCodeCreateSlot<T>(fn: () => Promise<T>): Promise<T> {
  const locked = () => withSerializedLock(CREATE_LOCK_KEY, fn, { waitMs: CREATE_LOCK_WAIT_MS });
  const run = claudeCodeCreateTail.then(locked, locked);
  claudeCodeCreateTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Test-only: reset the chain between cases. */
export function resetClaudeCodeCreateSlotForTests(): void {
  claudeCodeCreateTail = Promise.resolve();
}
