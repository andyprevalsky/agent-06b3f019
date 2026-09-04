/**
 * Serialize Claude Code sandbox creates process-wide.
 *
 * Concurrent `createClaudeCodeSession` calls stampede E2B's reserve-script
 * redis pool and return HTTP 500 `redis: connection pool timeout` (local
 * repro: cuda-kernel-github-top100-code-agent k=3 r8/r9, 2026-09-03). Agents
 * often fan out several `spawn_claude_code_agent` tool calls at once; one
 * create at a time keeps the reserve path healthy while callers await their
 * turn. Failures still propagate to the waiting caller.
 */
let claudeCodeCreateTail: Promise<void> = Promise.resolve();

export async function withClaudeCodeCreateSlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = claudeCodeCreateTail.then(fn, fn);
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
