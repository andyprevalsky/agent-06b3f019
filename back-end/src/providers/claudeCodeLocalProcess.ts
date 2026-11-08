/**
 * Process helpers for the local Claude Code ws-server fallback: allocate a
 * loopback port and wait for the child's authenticated readiness record.
 */
import type { ChildProcess } from 'child_process';
import { createServer } from 'net';

export async function allocatePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Failed to allocate local port'));
        return;
      }
      const { port } = addr;
      server.close((err) => {
        if (err) reject(err);
        else resolvePort(port);
      });
    });
    server.on('error', reject);
  });
}

export async function waitForChildReadiness(
  child: ChildProcess,
  port: number,
  readinessToken: string,
  timeoutMs: number
): Promise<boolean> {
  return await new Promise((resolveReady) => {
    let settled = false;
    let stdout = '';
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('error', onFailure);
      child.off('exit', onFailure);
      resolveReady(ready);
    };
    const onFailure = () => finish(false);
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (
            event.message === 'Server listening' &&
            event.port === port &&
            event.readinessToken === readinessToken
          ) {
            finish(true);
            return;
          }
        } catch {
          // Only the authenticated JSON readiness record can satisfy startup.
        }
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.stdout?.on('data', onData);
    child.once('error', onFailure);
    child.once('exit', onFailure);
  });
}

/** SIGKILL a local ws-server child; a child that already exited is not an error. */
export function killChildQuietly(child: ChildProcess): void {
  try {
    child.kill('SIGKILL');
  } catch {
    // already dead
  }
}
