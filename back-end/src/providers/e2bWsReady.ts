/**
 * Readiness wait for a sandbox's ws-server (Claude Code and Codex sessions).
 *
 * A bounded control-plane wait for one port to listen after the server is
 * launched — not a retry of a failed call and not a session runtime limit.
 */
import type { Sandbox } from 'e2b';

const PROBE_TIMEOUT_MS = 2000;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isListening(sandbox: Sandbox, port: number): Promise<boolean> {
  try {
    const result = await sandbox.commands.run(`netstat -tln | grep :${port}`, {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return result.exitCode === 0 && result.stdout.includes(`:${port}`);
  } catch {
    // Not listening yet (grep exits 1) or a transient probe failure.
    return false;
  }
}

export async function waitForSandboxWsServer(
  sandbox: Sandbox,
  opts: { port: number; timeoutMs: number; pollMs: number }
): Promise<{ ready: boolean; elapsedMs: number }> {
  const started = Date.now();
  while (Date.now() - started < opts.timeoutMs) {
    await sleepMs(opts.pollMs);
    if (await isListening(sandbox, opts.port)) {
      return { ready: true, elapsedMs: Date.now() - started };
    }
  }
  return { ready: false, elapsedMs: Date.now() - started };
}
